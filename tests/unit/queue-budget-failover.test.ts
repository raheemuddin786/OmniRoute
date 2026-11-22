import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkLimiterPause,
  rememberLimiterPause,
} from "../../open-sse/services/rateLimitManager/bodyRetryPause.ts";
import { shouldFailoverCandidateWhenCooldownExceedsBudget } from "../../open-sse/services/rateLimitManager.ts";

test("checkLimiterPause respects failover bypass when cooldown exceeds budget", () => {
  const dummyLimiter = {};
  const budgetMs = 120_000; // 120s budget
  const twentyFiveMinutesMs = 25 * 60 * 1000;
  const now = Date.now();

  rememberLimiterPause(dummyLimiter, now + twentyFiveMinutesMs);

  const pauseErr = checkLimiterPause(dummyLimiter, budgetMs, "claude-web/claude-sonnet-5-5", now);
  assert.ok(pauseErr, "Pause error generated for 25m cooldown vs 120s budget");
  assert.match(pauseErr.message, /past the 120000ms left in its queue budget/);
});

test("shouldFailoverCandidateWhenCooldownExceedsBudget returns true when wait exceeds maxWaitMs", () => {
  const budgetMs = 120_000;
  const twentyFiveMinutesMs = 25 * 60 * 1000;

  const result = shouldFailoverCandidateWhenCooldownExceedsBudget({
    cooldownRemainingMs: twentyFiveMinutesMs,
    budgetMs,
  });

  assert.equal(
    result,
    true,
    "Should fail over immediately without waiting or throwing queue budget error"
  );
});
