import { describe, it } from "node:test";
import assert from "node:assert";
import {
  inspectErrorResponse,
  checkCooldownStatus,
  registerCooldownBlock,
  checkRapidSubSecondThrottle,
  clearAllGlobalCooldowns,
  resolveConfiguredGracePeriodMs,
} from "../../open-sse/services/globalRateLimiter.ts";

describe("globalRateLimiter", () => {
  it("inspects 429 quota exhaustion with headers and grace period", () => {
    clearAllGlobalCooldowns();
    const headers = new Headers({
      "retry-after": "120",
    });
    const result = inspectErrorResponse({
      status: 429,
      errorBody: { error: { message: "Daily quota exceeded" } },
      headers,
      provider: "antigravity",
      connectionId: "conn-1",
      model: "gemini-2.5-pro",
    });

    assert.strictEqual(result.isBlocked, true);
    assert.strictEqual(result.scope, "model");
    assert.strictEqual(result.isModelSpecific, true);
    assert.strictEqual(result.cooldownMs, 120_000);
    assert.strictEqual(result.gracePeriodMs, resolveConfiguredGracePeriodMs());
    assert.strictEqual(result.totalBlockMs, 120_000 + resolveConfiguredGracePeriodMs());
    assert.strictEqual(result.retryAfterSeconds, 120);
  });

  it("inspects permanent account deactivation", () => {
    const result = inspectErrorResponse({
      status: 401,
      errorBody: "account has been deactivated",
      provider: "claude",
      connectionId: "conn-2",
    });

    assert.strictEqual(result.isBlocked, true);
    assert.strictEqual(result.scope, "account");
    assert.strictEqual(result.isPermanent, true);
  });

  it("enforces cooldown blocks and allows unblocked requests", () => {
    clearAllGlobalCooldowns();
    const inspection = inspectErrorResponse({
      status: 429,
      errorBody: "Rate limit exceeded",
      headers: new Headers({ "retry-after": "5" }),
      provider: "gemini",
      connectionId: "conn-3",
      model: "gemini-1.5-flash",
    });

    registerCooldownBlock({
      provider: "gemini",
      connectionId: "conn-3",
      model: "gemini-1.5-flash",
      inspection,
    });

    const statusCheck = checkCooldownStatus("gemini", "conn-3", "gemini-1.5-flash");
    assert.strictEqual(statusCheck.allowed, false);
    assert.strictEqual(statusCheck.scope, "model");

    // Sibling model should remain unblocked
    const siblingCheck = checkCooldownStatus("gemini", "conn-3", "gemini-2.5-pro");
    assert.strictEqual(siblingCheck.allowed, true);
  });

  it("throttles micro-burst sub-second requests", () => {
    clearAllGlobalCooldowns();
    const entityId = "test-client-ip";
    const res1 = checkRapidSubSecondThrottle(entityId);
    assert.strictEqual(res1.allowed, true);

    // Immediate second call should be caught by minimum gap check
    const res2 = checkRapidSubSecondThrottle(entityId);
    assert.strictEqual(res2.allowed, false);
    assert.strictEqual(res2.reason, "sub_second_burst_throttled");
  });
});
