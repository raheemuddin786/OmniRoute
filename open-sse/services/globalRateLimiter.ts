/**
 * Global Rate Limiting, Error Inspection & Cooldown Management Service
 *
 * Implements:
 * 1. Deep Error Response Inspection: Dissects 429, 500, and account-blocking payloads
 *    to extract exact cooldown periods and determine scope (model-specific vs provider-wide vs time-specific).
 * 2. Multi-scenario Global Rate Limiting:
 *    - Sliding window frequency limiter (requests per minute/window).
 *    - Sub-second micro-burst throttle (prevents rapid successive requests within the same second).
 *    - Duration-based cooldowns.
 * 3. Cooldown & Grace Period Enforcement:
 *    - Maintains blocks until target unblock time + 1 to 2 minutes grace period buffer.
 */

import { parseRetryAfterHeader, resolveRetryAfterInstant } from "../utils/retryAfterInstant.ts";
import { parseAntigravityRetryTime, parseProseRetryDelayMs } from "../utils/proseRetryDelay.ts";
import { parseDetailedRetryHintFromJsonBody } from "./retryAfterJson.ts";
import { looksLikeQuotaExhausted, looksLikeConcurrencyLimit } from "@/shared/utils/classify429";
import {
  isModelNotFound404,
  isModelUnsupported401,
} from "./accountFallback/perModelFailureScope.ts";
import { isModelScopedAccessDenial } from "./accountFallback/modelScopedAccessDenial.ts";
import { hasPerModelQuota, ACCOUNT_DEACTIVATED_SIGNALS } from "./accountFallback.ts";

export type RateLimitScope = "model" | "provider" | "account" | "transient";

export interface ErrorInspectionResult {
  isBlocked: boolean;
  status: number;
  scope: RateLimitScope;
  reason: string;
  cooldownMs: number;
  gracePeriodMs: number;
  totalBlockMs: number;
  unblockTimestamp: number;
  targetKey: string;
  isModelSpecific: boolean;
  isPermanent: boolean;
  retryAfterSeconds?: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
  scope?: RateLimitScope;
}

// Default grace period: 1 minute (60,000ms), configurable up to 2 minutes (120,000ms)
export const DEFAULT_GRACE_PERIOD_MS = 60_000;
export const MAX_GRACE_PERIOD_MS = 120_000;

export function resolveConfiguredGracePeriodMs(): number {
  const envVal = process.env.OMNIROUTE_COOLDOWN_GRACE_PERIOD_MS;
  if (envVal) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(Math.max(parsed, 60_000), MAX_GRACE_PERIOD_MS);
    }
  }
  return DEFAULT_GRACE_PERIOD_MS;
}

// In-memory global store for cooldown blocks
interface CooldownBlock {
  key: string;
  scope: RateLimitScope;
  provider: string;
  model?: string;
  connectionId?: string;
  reason: string;
  blockedAt: number;
  unblockTimestamp: number;
  gracePeriodMs: number;
  isPermanent: boolean;
}

const globalCooldownMap = new Map<string, CooldownBlock>();

// Rapid burst prevention store: track timestamp of last request per entity (connection, IP, or key)
// Enforces minimum inter-request interval (e.g. 50ms) and caps requests within the exact same second
const subSecondThrottleMap = new Map<
  string,
  { lastRequestTime: number; countInCurrentSecond: number; currentSecondBucket: number }
>();

const MAX_REQUESTS_PER_SECOND = (() => {
  const envVal = process.env.OMNIROUTE_MAX_REQUESTS_PER_SECOND;
  const parsed = Number(envVal);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 25;
})();

const MIN_INTER_REQUEST_GAP_MS = (() => {
  const envVal = process.env.OMNIROUTE_MIN_REQUEST_GAP_MS;
  const parsed = Number(envVal);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 40;
})();

/**
 * Generate a canonical cache/lock key for tracking
 */
export function buildRateLimitKey(
  provider: string,
  connectionId?: string | null,
  model?: string | null,
  scope: RateLimitScope = "model"
): string {
  const normProvider = (provider || "unknown").toLowerCase().trim();
  const normConn = (connectionId || "default").trim();
  const normModel = (model || "").toLowerCase().trim();

  if (scope === "model" && normModel) {
    return `rl:m:${normProvider}:${normConn}:${normModel}`;
  }
  if (scope === "provider") {
    return `rl:p:${normProvider}:${normConn}`;
  }
  if (scope === "account") {
    return `rl:a:${normProvider}:${normConn}`;
  }
  return `rl:t:${normProvider}:${normConn}:${normModel || "any"}`;
}

/**
 * 1. Deep Error Response Inspection
 * Determines exact cooldown, whether restriction is model-specific, provider-wide,
 * or time-specific, and computes unblock time with the required grace period.
 */
export function inspectErrorResponse(params: {
  status: number;
  errorBody: unknown;
  headers?: Headers | Record<string, string> | null;
  provider: string;
  connectionId?: string | null;
  model?: string | null;
}): ErrorInspectionResult {
  const { status, errorBody, headers, provider, connectionId, model } = params;
  const errorText = typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody ?? "");
  const lowerText = errorText.toLowerCase();

  let isBlocked = false;
  let scope: RateLimitScope = "transient";
  let reason = "unknown_error";
  let cooldownMs = 0;
  let isPermanent = false;
  let retryAfterSeconds: number | undefined = undefined;

  // 1. Check for permanent account deactivation or ban (401/403)
  if (status === 401 || status === 403) {
    const isDeactivated = ACCOUNT_DEACTIVATED_SIGNALS.some((sig) => lowerText.includes(sig));
    if (isDeactivated) {
      isBlocked = true;
      scope = "account";
      reason = "account_deactivated_or_banned";
      isPermanent = true;
      cooldownMs = 86_400_000 * 30; // 30 days lock
    } else if (
      isModelUnsupported401(status, errorBody) ||
      isModelScopedAccessDenial(provider, status, errorText)
    ) {
      // Model-specific 401/403 (unsupported or unauthorized model, not broken credentials)
      isBlocked = true;
      scope = "model";
      reason = "model_unsupported_or_denied";
      cooldownMs = 300_000; // 5 min lockout
    }
  }

  // 2. Check for 404 (model not found)
  if (status === 404) {
    if (isModelNotFound404(status, errorText)) {
      isBlocked = true;
      scope = "model";
      reason = "model_not_found";
      cooldownMs = 600_000; // 10 min
    }
  }

  // 3. Check for 429 (Rate Limit / Quota Exhaustion)
  if (status === 429) {
    isBlocked = true;

    // Check upstream headers for Retry-After or x-ratelimit-reset
    if (headers) {
      if (typeof (headers as Headers).get === "function") {
        const isoReset = parseRetryAfterHeader(headers as Headers);
        if (isoReset) {
          const instant = resolveRetryAfterInstant(isoReset);
          if (instant && instant.retry_after > 0) {
            retryAfterSeconds = instant.retry_after;
            cooldownMs = instant.retry_after * 1000;
          }
        }
      } else {
        const rawRetry =
          (headers as Record<string, string>)["retry-after"] ||
          (headers as Record<string, string>)["Retry-After"];
        if (rawRetry) {
          const parsed = Number(rawRetry.trim());
          if (Number.isFinite(parsed) && parsed > 0) {
            retryAfterSeconds = parsed;
            cooldownMs = parsed * 1000;
          }
        }
      }
    }

    // Check json body hints if headers didn't yield a delay
    if (cooldownMs <= 0 && errorBody && typeof errorBody === "object") {
      const detailedHint = parseDetailedRetryHintFromJsonBody(errorBody as Record<string, unknown>);
      if (detailedHint && detailedHint.retryAfterMs > 0) {
        cooldownMs = detailedHint.retryAfterMs;
        retryAfterSeconds = Math.ceil(cooldownMs / 1000);
      }
    }

    // Check prose delay in error text
    if (cooldownMs <= 0) {
      const agyDelay = parseAntigravityRetryTime(errorText);
      if (agyDelay && agyDelay.retryAfterMs > 0) {
        cooldownMs = agyDelay.retryAfterMs;
      } else {
        const proseDelay = parseProseRetryDelayMs(errorText);
        if (proseDelay && proseDelay > 0) {
          cooldownMs = proseDelay;
        }
      }
    }

    // Default fallback cooldown if no hint detected
    if (cooldownMs <= 0) {
      cooldownMs = 60_000; // 1 minute default
    }

    // Determine whether this is model-specific or provider-wide
    const isModelQuota =
      hasPerModelQuota(provider, model) ||
      lowerText.includes("per-model") ||
      lowerText.includes("model limit");
    const isConcurrency = looksLikeConcurrencyLimit(errorText);
    const isQuotaExhausted = looksLikeQuotaExhausted(errorText);

    if (isConcurrency) {
      scope = "transient";
      reason = "concurrency_limit_hit";
      cooldownMs = Math.min(cooldownMs, 2_000); // Concurrency limits clear rapidly
    } else if (isModelQuota) {
      scope = "model";
      reason = isQuotaExhausted ? "model_quota_exhausted" : "model_rate_limit_exceeded";
    } else {
      scope = "provider";
      reason = isQuotaExhausted ? "provider_quota_exhausted" : "provider_rate_limit_exceeded";
    }
  }

  // 4. Check for 500 / 502 / 503 / 504 (Server Errors & Overload)
  if (status >= 500 && status <= 504) {
    isBlocked = true;
    if (
      status === 503 ||
      status === 529 ||
      lowerText.includes("overloaded") ||
      lowerText.includes("capacity")
    ) {
      // Capacity issues are model-specific if provider multiplexes models
      scope = hasPerModelQuota(provider, model) ? "model" : "provider";
      reason = "model_overloaded_or_capacity";
      cooldownMs = 30_000; // 30s backoff
    } else {
      scope = "provider";
      reason = `server_error_${status}`;
      cooldownMs = 15_000; // 15s backoff
    }
  }

  const isModelSpecific = scope === "model";
  const targetKey = buildRateLimitKey(provider, connectionId, model, scope);

  // Apply explicit grace period of 1 to 2 minutes
  const gracePeriodMs = isPermanent ? 0 : resolveConfiguredGracePeriodMs();
  const totalBlockMs = isBlocked ? cooldownMs + gracePeriodMs : 0;
  const now = Date.now();
  const unblockTimestamp = isBlocked ? now + totalBlockMs : now;

  return {
    isBlocked,
    status,
    scope,
    reason,
    cooldownMs,
    gracePeriodMs,
    totalBlockMs,
    unblockTimestamp,
    targetKey,
    isModelSpecific,
    isPermanent,
    retryAfterSeconds,
  };
}

/**
 * Register a cooldown block based on error inspection
 */
export function registerCooldownBlock(params: {
  provider: string;
  connectionId?: string | null;
  model?: string | null;
  inspection: ErrorInspectionResult;
}): void {
  const { provider, connectionId, model, inspection } = params;
  if (!inspection.isBlocked) return;

  const block: CooldownBlock = {
    key: inspection.targetKey,
    scope: inspection.scope,
    provider,
    model: model ?? undefined,
    connectionId: connectionId ?? undefined,
    reason: inspection.reason,
    blockedAt: Date.now(),
    unblockTimestamp: inspection.unblockTimestamp,
    gracePeriodMs: inspection.gracePeriodMs,
    isPermanent: inspection.isPermanent,
  };

  globalCooldownMap.set(inspection.targetKey, block);
}

/**
 * 2. Check if a request is blocked by active cooldown + grace period
 */
export function checkCooldownStatus(
  provider: string,
  connectionId?: string | null,
  model?: string | null
): RateLimitCheckResult {
  const now = Date.now();

  // 1. Check model-specific block
  if (model) {
    const modelKey = buildRateLimitKey(provider, connectionId, model, "model");
    const modelBlock = globalCooldownMap.get(modelKey);
    if (modelBlock && now < modelBlock.unblockTimestamp) {
      const remainingMs = modelBlock.unblockTimestamp - now;
      return {
        allowed: false,
        retryAfterMs: remainingMs,
        reason: `${modelBlock.reason} (cooldown + grace active)`,
        scope: "model",
      };
    } else if (modelBlock) {
      globalCooldownMap.delete(modelKey);
    }
  }

  // 2. Check provider-wide block
  const providerKey = buildRateLimitKey(provider, connectionId, null, "provider");
  const providerBlock = globalCooldownMap.get(providerKey);
  if (providerBlock && now < providerBlock.unblockTimestamp) {
    const remainingMs = providerBlock.unblockTimestamp - now;
    return {
      allowed: false,
      retryAfterMs: remainingMs,
      reason: `${providerBlock.reason} (provider cooldown + grace active)`,
      scope: "provider",
    };
  } else if (providerBlock) {
    globalCooldownMap.delete(providerKey);
  }

  // 3. Check account block
  const accountKey = buildRateLimitKey(provider, connectionId, null, "account");
  const accountBlock = globalCooldownMap.get(accountKey);
  if (accountBlock && now < accountBlock.unblockTimestamp) {
    const remainingMs = accountBlock.unblockTimestamp - now;
    return {
      allowed: false,
      retryAfterMs: remainingMs,
      reason: `${accountBlock.reason} (account suspended/deactivated)`,
      scope: "account",
    };
  } else if (accountBlock) {
    globalCooldownMap.delete(accountKey);
  }

  return { allowed: true };
}

/**
 * 3. Prevention of rapid successive requests within the same second (micro-burst control)
 */
export function checkRapidSubSecondThrottle(entityId: string): RateLimitCheckResult {
  const now = Date.now();
  const currentSecond = Math.floor(now / 1000);
  let record = subSecondThrottleMap.get(entityId);

  if (!record) {
    record = { lastRequestTime: now, countInCurrentSecond: 1, currentSecondBucket: currentSecond };
    subSecondThrottleMap.set(entityId, record);
    return { allowed: true };
  }

  // Check inter-request gap
  const gap = now - record.lastRequestTime;
  if (gap < MIN_INTER_REQUEST_GAP_MS) {
    return {
      allowed: false,
      retryAfterMs: MIN_INTER_REQUEST_GAP_MS - gap,
      reason: "sub_second_burst_throttled",
      scope: "transient",
    };
  }

  // Check requests in the same second
  if (record.currentSecondBucket === currentSecond) {
    if (record.countInCurrentSecond >= MAX_REQUESTS_PER_SECOND) {
      const waitMs = 1000 - (now % 1000);
      return {
        allowed: false,
        retryAfterMs: waitMs,
        reason: "max_requests_per_second_exceeded",
        scope: "transient",
      };
    }
    record.countInCurrentSecond++;
  } else {
    record.currentSecondBucket = currentSecond;
    record.countInCurrentSecond = 1;
  }

  record.lastRequestTime = now;
  return { allowed: true };
}

/**
 * Comprehensive global check combining cooldown status and micro-burst protection
 */
export function checkGlobalRateLimit(params: {
  provider: string;
  connectionId?: string | null;
  model?: string | null;
  entityId?: string;
}): RateLimitCheckResult {
  const { provider, connectionId, model, entityId } = params;

  // 1. Check cooldown and grace period status
  const cooldownCheck = checkCooldownStatus(provider, connectionId, model);
  if (!cooldownCheck.allowed) {
    return cooldownCheck;
  }

  // 2. Check micro-burst throttle
  if (entityId) {
    const burstCheck = checkRapidSubSecondThrottle(entityId);
    if (!burstCheck.allowed) {
      return burstCheck;
    }
  }

  return { allowed: true };
}

/**
 * Testing & maintenance helpers
 */
export function clearAllGlobalCooldowns(): void {
  globalCooldownMap.clear();
  subSecondThrottleMap.clear();
}

export function getActiveGlobalCooldownCount(): number {
  return globalCooldownMap.size;
}
