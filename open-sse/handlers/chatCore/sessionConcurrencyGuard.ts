/**
 * Session Concurrency Guard for Parallel Request Isolation
 *
 * Prevents concurrent duplicate requests to the same model per session/connection,
 * and intelligently handles fallback to alternative models to preserve cache efficiency.
 *
 * Core Requirements:
 * 1. Lock a specific provider:connection:model tuple for the duration of a request.
 * 2. If locked, wait for completion or redirect to an alternative available model.
 * 3. Release the lock once the request completes (success or error).
 * 4. Preserve prompt-cache integrity by maintaining session consistency.
 */

import { lockExactModel, clearModelLock } from "../../services/accountFallback.ts";
import {
  checkGlobalRateLimit,
  checkCooldownStatus,
  buildRateLimitKey,
} from "../../services/globalRateLimiter.ts";
import { getIsoContext, createIsoContextKey, type IsoContext } from "./isoContext.ts";
import { getTierConfig } from "../../services/tierResolver.ts";
import { PROVIDER_MODELS } from "../../config/providerModels.ts";

export interface SessionConcurrencyGuard {
  acquire(
    model: string,
    provider: string,
    connectionId: string,
    sessionId: string
  ): Promise<ConcurrentRequestToken>;
  release(token: ConcurrentRequestToken): Promise<void>;
}

export interface ConcurrentRequestToken {
  key: string;
  provider: string;
  connectionId: string;
  model: string;
  sessionId: string;
  acquiredAt: number;
  abort(): Promise<void>;
}

export interface ConcurrentRequestResult {
  success: boolean;
  token?: ConcurrentRequestToken;
  suggestedFallback?: string;
}

class SessionConcurrencyGuardImpl implements SessionConcurrencyGuard {
  constructor(private readonly isoContext: IsoContext) {}

  async acquire(
    model: string,
    provider: string,
    connectionId: string,
    sessionId: string
  ): Promise<ConcurrentRequestToken> {
    const rateLimitKey = buildRateLimitKey(provider, connectionId, model, "model");
    const now = Date.now();

    // 1. Check global rate limit and cooldown blocks (includes grace period)
    const globalCheck = checkGlobalRateLimit({
      provider,
      connectionId,
      model,
      entityId: connectionId,
    });
    if (!globalCheck.allowed) {
      throw new Error(
        `Request rejected: ${globalCheck.reason || "rate limited"}. Retry after ${globalCheck.retryAfterMs}ms`
      );
    }

    // 2. Lock the exact model to block concurrent requests
    lockExactModel(provider, connectionId, model, "concurrent_request", 3_600_000);

    // Check if we already have an active request for this model in this session
    const existingRequestKey = createIsoContextKey(
      "session_lock",
      provider,
      connectionId,
      model,
      sessionId
    );
    const existingLock = this.isoContext.getSessionLock(existingRequestKey) as
      ConcurrentRequestToken | undefined;
    if (existingLock) {
      const fallback = await this.handleExistingRequest(provider, connectionId, model, sessionId);
      if (fallback.success && fallback.token) {
        return this.createRequestToken(fallback.token, provider, connectionId, model, sessionId);
      }
      throw new Error(
        `Concurrent request blocked to model ${model}. Fallback suggested: ${fallback.suggestedFallback || "none"}`
      );
    }

    // 3. Create and store the concurrent request token
    const token: ConcurrentRequestToken = {
      key: rateLimitKey,
      provider,
      connectionId,
      model,
      sessionId,
      acquiredAt: now,
      abort: async () => {
        await this.release(token);
      },
    };

    // 4. Store token in ISO context for this session
    this.isoContext.setSessionLock(existingRequestKey, token);

    return token;
  }

  async release(token: ConcurrentRequestToken): Promise<void> {
    const existingRequestKey = createIsoContextKey(
      "session_lock",
      token.provider,
      token.connectionId,
      token.model,
      token.sessionId
    );
    this.isoContext.deleteSessionLock(existingRequestKey);

    try {
      clearModelLock(token.provider, token.connectionId, token.model);
    } catch {
      // Cleanup failure is non-fatal
    }
  }

  private async handleExistingRequest(
    provider: string,
    connectionId: string,
    model: string,
    sessionId: string
  ): Promise<ConcurrentRequestResult> {
    const existingRequestKey = createIsoContextKey(
      "session_lock",
      provider,
      connectionId,
      model,
      sessionId
    );

    // 1. Brief poll to allow in-flight request to release lock normally
    const waitTimeoutMs = 1500;
    const pollIntervalMs = 50;
    const start = Date.now();

    while (Date.now() - start < waitTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const activeLock = this.isoContext.getSessionLock(existingRequestKey);
      if (!activeLock) {
        try {
          const token = await this.acquire(model, provider, connectionId, sessionId);
          return { success: true, token };
        } catch {
          // If acquiring again throws due to re-locking, proceed to alternatives
          break;
        }
      }
    }

    // 2. Query healthy alternative models in the same tier or provider
    const alternativeModels = await this.getAlternativeModels(provider, connectionId, model);

    if (alternativeModels.length === 0) {
      return {
        success: false,
        suggestedFallback: `No alternative models available for provider ${provider}`,
      };
    }

    for (const altModel of alternativeModels) {
      try {
        const altToken = await this.acquire(altModel, provider, connectionId, sessionId);
        return {
          success: true,
          token: altToken,
          suggestedFallback: `Switched to alternative model: ${altModel}`,
        };
      } catch {
        // Try next alternative if this one is busy or in cooldown
      }
    }

    return {
      success: false,
      suggestedFallback: `All alternative models busy or in cooldown for provider ${provider}`,
    };
  }

  private async getAlternativeModels(
    provider: string,
    connectionId: string,
    currentModel: string
  ): Promise<string[]> {
    const alternatives: string[] = [];
    const normCurrent = (currentModel || "").toLowerCase().trim();

    // 1. Check tier configuration for sibling models in the same tier
    try {
      const tierConfig = getTierConfig();
      const tierModels = tierConfig?.tierModels;
      if (tierModels) {
        for (const tierKey of ["apex", "resilient", "local"] as const) {
          const list = tierModels[tierKey] || [];
          if (list.some((m) => m.toLowerCase().trim() === normCurrent)) {
            for (const candidate of list) {
              if (candidate.toLowerCase().trim() !== normCurrent) {
                alternatives.push(candidate);
              }
            }
          }
        }
      }
    } catch {
      // Non-fatal if tier config lookup fails
    }

    // 2. Check provider models from the provider registry
    if (alternatives.length === 0) {
      try {
        const provModels = PROVIDER_MODELS[provider] || [];
        for (const entry of provModels) {
          const candidateId = entry.id;
          if (candidateId.toLowerCase().trim() !== normCurrent) {
            alternatives.push(candidateId);
          }
        }
      } catch {
        // Non-fatal
      }
    }

    // 3. Filter out any candidate currently in rate limit cooldown or lockout
    const healthyAlternatives = alternatives.filter((candidate) => {
      const status = checkCooldownStatus(provider, connectionId, candidate);
      return status.allowed;
    });

    return healthyAlternatives;
  }

  private createRequestToken(
    token: ConcurrentRequestToken,
    provider: string,
    connectionId: string,
    model: string,
    sessionId: string
  ): ConcurrentRequestToken {
    return {
      key: token.key,
      provider,
      connectionId,
      model,
      sessionId,
      acquiredAt: Date.now(),
      abort: async () => {
        await this.release(token);
      },
    };
  }
}

export const createSessionConcurrencyGuard = (): SessionConcurrencyGuard => {
  return new SessionConcurrencyGuardImpl(getIsoContext());
};
