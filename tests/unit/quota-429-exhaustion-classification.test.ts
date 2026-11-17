import test from "node:test";
import assert from "node:assert/strict";
import { classify429 } from "../../src/shared/utils/classify429.ts";
import { isCreditsExhausted } from "../../open-sse/services/accountFallback.ts";

test("Task B: quota exhaustion markers classify as quota_exhausted", () => {
  const marker1 = classify429({
    status: 429,
    body: JSON.stringify({ error: { message: "Free model usage limit reached" } }),
  });
  assert.equal(marker1, "quota_exhausted");

  const marker2 = classify429({
    status: 429,
    body: JSON.stringify({ error: { message: "You have exceeded your quota exceeded limit" } }),
  });
  assert.equal(marker2, "quota_exhausted");

  assert.equal(isCreditsExhausted("free model usage limit"), true);
  assert.equal(isCreditsExhausted("usage limit reached"), true);
  assert.equal(isCreditsExhausted("quota exceeded"), true);
});
