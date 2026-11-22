import test from "node:test";
import assert from "node:assert/strict";
import { getCooldownAwareRetryDecision } from "../../src/sse/services/cooldownAwareRetry.ts";

test("Task A: standard providers retry within budget", () => {
  const retrySettings = {
    enabled: true,
    maxRetries: 3,
    maxRetryWaitMs: 60000,
    budgetMs: 120000,
  };
  const decision = getCooldownAwareRetryDecision({
    retryAfter: new Date(Date.now() + 10000).toISOString(),
    settings: retrySettings,
    attempt: 0,
    budgetLeftMs: 120000,
    lastErrorCode: 429,
  });
  // Decision for generic providers is to retry
  assert.equal(decision.shouldRetry, true);
  assert.ok(decision.waitMs > 0);
});
