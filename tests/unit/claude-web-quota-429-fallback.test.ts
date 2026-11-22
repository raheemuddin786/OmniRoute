import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFallbackError } from "../../open-sse/services/accountFallback.ts";
import { shouldPreserveQuotaSignals } from "../../open-sse/services/quotaResetParsing.ts";

test("quota-window provider preserves quota signals on headerless 429", () => {
  // shouldPreserveQuotaSignals must be true for quota-window / web-cookie providers even without explicit quota text
  const preserved = shouldPreserveQuotaSignals("claude-web", "Rate limited by Claude Web API");
  assert.equal(preserved, true, "Quota signals must be preserved for quota-window provider on 429");
});

test("checkFallbackError treats generic 429 as transient rate limit", () => {
  const result = checkFallbackError(
    429,
    "Rate limited by Claude Web API",
    0,
    "claude-sonnet-5-5",
    "claude-web"
  );
  assert.equal(result.shouldFallback, true);
  // Transient generic 429 should not lock account for 5 hours
  assert.notEqual(result.reason, "quota_exhausted");
  assert.ok(result.cooldownMs < 5 * 60 * 60 * 1000);
});

test("checkFallbackError assigns 5h quota window cooldown when quota text is present", () => {
  const result = checkFallbackError(
    429,
    "You have reached your usage limit until 3pm",
    0,
    "claude-sonnet-5-5",
    "claude-web"
  );
  assert.equal(result.shouldFallback, true);
  assert.equal(
    result.cooldownMs,
    5 * 60 * 60 * 1000,
    "Should assign 5h (18000000ms) cooldown for quota-window provider 429 with explicit quota text"
  );
  assert.equal(result.reason, "quota_exhausted");
});
