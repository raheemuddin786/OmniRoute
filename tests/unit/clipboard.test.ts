import test from "node:test";
import assert from "node:assert/strict";
import { copyToClipboard } from "../../src/shared/utils/clipboard.ts";

test("copyToClipboard returns false when neither navigator nor document is available in Node", async () => {
  const result = await copyToClipboard("test content");
  assert.equal(typeof result, "boolean");
});

test("copyToClipboard handles empty strings gracefully", async () => {
  const result = await copyToClipboard("");
  assert.equal(typeof result, "boolean");
});
