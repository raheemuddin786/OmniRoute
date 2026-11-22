import test from "node:test";
import assert from "node:assert/strict";
import { validateDirectChatProvider } from "@/lib/providers/validation/directChatProbe";

test("validateDirectChatProvider treats 402 Payment Required as valid with warning", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Insufficient credits", code: 402 } }), {
      status: 402,
      statusText: "Payment Required",
      headers: { "Content-Type": "application/json" },
    });

  const result = await validateDirectChatProvider({
    url: "https://api.cline.bot/api/v1/chat/completions",
    headers: {},
    body: { model: "cline-free/deepseek-v4.1-flash" },
  });

  assert.equal(result.valid, true, "402 must be treated as valid key/account");
  assert.equal(result.error, null, "error must be null for valid credential");
  assert.equal(result.statusCode, 402, "statusCode must be preserved as 402");
  assert.match(
    result.warning || "",
    /payment|credits/i,
    "warning should indicate payment/credits required"
  );
});
