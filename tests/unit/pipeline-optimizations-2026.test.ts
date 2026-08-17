import test from "node:test";
import assert from "node:assert/strict";

test("Pipeline Optimizations (August 2026)", async (t) => {
  await t.test("1. Circuit Breaker background recovery prober exports and lifecycle", async () => {
    const { startCircuitBreakerRecoveryProber, stopCircuitBreakerRecoveryProber } =
      await import("../../src/shared/utils/circuitBreaker.ts");

    assert.strictEqual(typeof startCircuitBreakerRecoveryProber, "function");
    assert.strictEqual(typeof stopCircuitBreakerRecoveryProber, "function");

    // Exercise starting and stopping the recovery prober timer safely
    startCircuitBreakerRecoveryProber(5000);
    stopCircuitBreakerRecoveryProber();
  });

  await t.test("2. Diagnostic response headers registered and populated", async () => {
    const { OMNIROUTE_RESPONSE_HEADERS } = await import("../../src/shared/constants/headers.ts");
    assert.strictEqual(OMNIROUTE_RESPONSE_HEADERS.targetAttempts, "X-OmniRoute-Target-Attempts");
    assert.strictEqual(OMNIROUTE_RESPONSE_HEADERS.failureReason, "X-OmniRoute-Failure-Reason");

    const { buildOmniRouteResponseMetaHeaders } =
      await import("../../src/domain/omnirouteResponseMeta.ts");
    const headers = buildOmniRouteResponseMetaHeaders({
      targetAttempts: 3,
      failureReason: "rate_limit_exceeded",
    });

    assert.strictEqual(headers["X-OmniRoute-Target-Attempts"], "3");
    assert.strictEqual(headers["X-OmniRoute-Failure-Reason"], "rate_limit_exceeded");
  });

  await t.test(
    "3. classifyLockoutReason includes 410 model_shutdown and 404 not_found",
    async () => {
      const { classifyLockoutReason } = await import("../../open-sse/services/accountFallback.ts");

      assert.strictEqual(classifyLockoutReason(429), "rate_limit");
      assert.strictEqual(classifyLockoutReason(403), "quota_exhausted");
      assert.strictEqual(classifyLockoutReason(410), "model_shutdown");
      assert.strictEqual(classifyLockoutReason(404), "not_found");
      assert.strictEqual(classifyLockoutReason(500), "unknown");
    }
  );

  await t.test("4. normalizeStreamFailurePayload trims string messages and codes", async () => {
    const { normalizeStreamFailurePayload } =
      await import("../../open-sse/utils/streamErrorFormat.ts");

    const payload = {
      error: {
        code: "  rate_limit_exceeded  ",
        message: "  Quota reached for model  ",
        status: 429,
      },
    };

    const normalized = normalizeStreamFailurePayload(payload);
    assert.ok(normalized);
    assert.strictEqual(normalized?.code, "rate_limit_exceeded");
    assert.strictEqual(normalized?.message, "Quota reached for model");
    assert.strictEqual(normalized?.status, 429);
  });
});
