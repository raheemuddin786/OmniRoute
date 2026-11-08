import { test } from "node:test";
import assert from "node:assert";
import { isModelLocked } from "../../open-sse/services/accountFallback.ts";
import {
  updateFromResponseBody,
  enableRateLimitProtection,
  __resetRateLimitManagerForTests,
} from "../../open-sse/services/rateLimitManager.ts";

test.beforeEach(async () => {
  await __resetRateLimitManagerForTests();
});

test("rate-limit pause prevents model selection via isModelLocked", () => {
  const provider = "openrouter";
  const connectionId = "conn-123";
  const model = "google/gemma-4-31b-it:free";

  enableRateLimitProtection(connectionId);

  // Initially not locked
  assert.strictEqual(isModelLocked(provider, connectionId, model), false);

  // Trigger rate limit pause via updateFromResponseBody ("Please retry after 600s")
  updateFromResponseBody(
    provider,
    connectionId,
    JSON.stringify({ error: { message: "Please retry after 600s" } }),
    429,
    model
  );

  // Now isModelLocked should return true
  assert.strictEqual(isModelLocked(provider, connectionId, model), true);
});
