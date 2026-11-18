import { test } from "node:test";
import assert from "node:assert/strict";
import { getCooldownAwareRetryDecision } from "../../src/sse/services/cooldownAwareRetry.ts";
import { jitterCooldownDelayMs } from "../../src/sse/services/cooldownAwareRetry.ts";

test("jitterCooldownDelayMs returns jittered delay in [base/2, base]", () => {
  const baseMs = 10_000;
  const mockRandomLow = () => 0.0;
  const mockRandomHigh = () => 1.0;

  const low = jitterCooldownDelayMs(baseMs, mockRandomLow);
  const high = jitterCooldownDelayMs(baseMs, mockRandomHigh);

  assert.equal(low, 5_000, "With random=0, jitter is base/2");
  assert.equal(high, 10_000, "With random=1, jitter is base");
});

test("getCooldownAwareRetryDecision jitters retry wait so it never fires at exact reset time", () => {
  const resetDelayMs = 10_000;
  const retryAfter = new Date(Date.now() + resetDelayMs).toISOString();
  const settings = {
    enabled: true,
    maxRetries: 3,
    maxRetryWaitMs: 30_000,
    budgetMs: 60_000,
  };

  const decision = getCooldownAwareRetryDecision({
    retryAfter,
    settings,
    attempt: 0,
    budgetLeftMs: 60_000,
    random: () => 0.25, // Mocked to test non-exact firing
  });

  assert.equal(decision.shouldRetry, true);
  // (0.5 + 0.25 * 0.5) = 0.625 -> 6250ms
  assert.notEqual(decision.waitMs, resetDelayMs, "Must not fire at exact reset delay");
  assert.ok(decision.waitMs <= resetDelayMs && decision.waitMs >= resetDelayMs / 2);
});
