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
import { checkGlobalRateLimit, buildRateLimitKey } from "../../services/globalRateLimiter.ts";
import { getIsoContext, createIsoContextKey, type IsoContext } from "./isoContext.ts";

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
    const alternativeModels = await this.getAlternativeModels(provider, connectionId, model);

    if (alternativeModels.length === 0) {
      return {
        success: false,
        suggestedFallback: `No alternative models available for provider ${provider}`,
      };
    }

    const altModel = alternativeModels[0];
    const altToken = await this.acquire(altModel, provider, connectionId, sessionId);
    return {
      success: true,
      token: altToken,
      suggestedFallback: `Switched to alternative model: ${altModel}`,
    };
  }

  private async getAlternativeModels(
    _provider: string,
    _connectionId: string,
    _currentModel: string
  ): Promise<string[]> {
    return [];
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
