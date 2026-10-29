/**
 * Provider Execution Pipeline with Global Rate Limiting, Error Inspection & Concurrency Control
 *
 * Orchestrates the request flow through the resilience layer, with integrated error inspection,
 * global rate limiting, and session-based concurrency control.
 */

import {
  checkGlobalRateLimit,
  inspectErrorResponse,
  registerCooldownBlock,
} from "../services/globalRateLimiter.ts";
import {
  createSessionConcurrencyGuard,
  type ConcurrentRequestToken,
} from "./sessionConcurrencyGuard.ts";
import {
  lockExactModel,
  recordModelLockoutFailure,
  selectLockoutCooldownMs,
} from "../services/accountFallback.ts";
import { getProviderProfile } from "../config/providerRegistry.ts";
import { COOLDOWN_MS } from "../config/constants.ts";
import {
  isModelScopedAccessDenial,
  isModelUnsupported401,
  isModelNotFound404,
  isRequestScoped400,
} from "../services/accountFallback.ts";

/** Pipeline execution context */
export interface PipelineContext {
  provider: string;
  connectionId: string;
  model: string;
  sessionId?: string;
  reason?: string;
  rawError?: unknown;
  headers?: Headers | Record<string, string> | null;
}

/** Pipeline execution result */
export interface PipelineResult {
  success: boolean;
  error?: Error;
  cooldownMs?: number;
  blockUntil?: number;
  skipProviderBreaker?: boolean;
  fallback?: boolean;
  alternativeModel?: string;
}

/** Execute a request through the enhanced provider pipeline with global rate limiting and concurrency control */
export async function executeWithGlobalPipeline(params: {
  provider: string;
  connectionId: string;
  model: string;
  sessionId: string;
  executeRequest: () => Promise<PipelineResult>;
}): Promise<PipelineResult> {
  const { provider, connectionId, model, sessionId, executeRequest } = params;
  const concurrencyGuard = createSessionConcurrencyGuard();
  let requestToken: ConcurrentRequestToken | null = null;

  try {
    // 1. Acquire concurrency guard to prevent duplicate concurrent requests to the same model
    requestToken = await concurrencyGuard.acquire(model, provider, connectionId, sessionId);

    // 2. Perform global rate limiting check (includes sub-second burst throttle)
    const rateLimitCheck = checkGlobalRateLimit({
      provider,
      connectionId,
      model,
      entityId: connectionId,
    });

    if (!rateLimitCheck.allowed) {
      throw new Error(
        `Request blocked: ${rateLimitCheck.reason}. Retry after ${rateLimitCheck.retryAfterMs}ms`
      );
    }

    // 3. Execute the actual provider request
    const result = await executeRequest();

    if (result.success) {
      // On success, clear concurrency locks
      await concurrencyGuard.release(requestToken);
    } else {
      // 4. Error inspection and block registration if needed
      await processErrorForPipeline(result, { provider, connectionId, model, sessionId });
    }

    return result;
  } catch (error) {
    const errorResult: PipelineResult = {
      success: false,
      error: error as Error,
    };

    await processErrorForPipeline(errorResult, { provider, connectionId, model, sessionId });
    return errorResult;
  }
}

/** Process errors and register cooldown blocks in the pipeline */
export async function processErrorForPipeline(
  result: PipelineResult,
  context: PipelineContext
): Promise<void> {
  const { provider, connectionId, model } = context;

  if (result.success) {
    return;
  }

  // Extract error details
  const errorText = result.error?.message || "";
  const status = result.error?.message?.includes("status")
    ? parseInt(result.error.message.match(/status:(\d+)/)?.[1] || "0", 10)
    : 500;

  // 1. Check for 429 / 500 errors and inspect for detailed error information
  if (status === 429 || status === 500) {
    // Perform deep error response inspection
    const inspection = inspectErrorResponse({
      status,
      errorBody: result.error,
      headers: context.headers,
      provider,
      connectionId,
      model,
    });

    if (inspection.isBlocked) {
      // Register the cooldown block with grace period
      registerCooldownBlock({
        provider,
        connectionId,
        model,
        inspection,
      });

      // Record model lockout failure with appropriate cooldown
      const profile = getProviderProfile(provider);
      const lockoutCooldown = selectLockoutCooldownMs(
        inspection.cooldownMs || COOLDOWN_MS.rateLimit,
        {
          baseCooldownMs: COOLDOWN_MS.rateLimit,
          useExponentialBackoff: profile.useExponentialBackoff || false,
        }
      );

      await recordModelLockoutFailure(
        provider,
        connectionId,
        model,
        inspection.reason || "rate_limit_error",
        status,
        lockoutCooldown,
        profile,
        {
          exactCooldownMs: inspection.retryAfterSeconds
            ? inspection.retryAfterSeconds * 1000
            : null,
          maxCooldownMs: profile.maxCooldownMs,
          scope: inspection.isModelSpecific ? "exact" : "quota_family",
          exactCooldownIsUpstreamReset: !!inspection.retryAfterSeconds,
        }
      );
    }
  }

  // 2. Handle specific error patterns for immediate actions
  if (status === 401 && isModelScopedAccessDenial(provider, status, errorText)) {
    lockExactModel(provider, connectionId, model, "model_scope_denied", COOLDOWN_MS.authError);
  }

  if (status === 401 && isModelUnsupported401(status, errorText)) {
    lockExactModel(provider, connectionId, model, "model_unsupported", COOLDOWN_MS.modelCapacity);
  }

  if (status === 404 && isModelNotFound404(status, errorText)) {
    lockExactModel(provider, connectionId, model, "model_not_found", COOLDOWN_MS.modelCapacity);
  }

  if (status === 400 && isRequestScoped400(status, errorText)) {
    // Record failure but do not lockout the connection for request-scoped 400s
    recordModelLockoutFailure(
      provider,
      connectionId,
      model,
      "request_validation_failure",
      status,
      COOLDOWN_MS.requestValidationError,
      null,
      {
        exactCooldownMs: null,
        maxCooldownMs: COOLDOWN_MS.requestValidationError,
        scope: "exact",
      }
    );
  }
}

/** Execute a provider request with the enhanced pipeline, returning a clean result */
export async function executeProviderRequestWithPipeline(params: {
  provider: string;
  connectionId: string;
  model: string;
  sessionId: string;
  requestFn: () => Promise<PipelineResult>;
}): Promise<PipelineResult> {
  return executeWithGlobalPipeline({
    provider: params.provider,
    connectionId: params.connectionId,
    model: params.model,
    sessionId: params.sessionId,
    executeRequest: params.requestFn,
  });
}
