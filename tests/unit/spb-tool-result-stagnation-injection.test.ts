import test from "node:test";
import assert from "node:assert/strict";
import { processSmartProxyRouting } from "../../open-sse/services/spb/proxyBridge.ts";
import { detectAndRecoverFromStagnation } from "../../open-sse/services/spb/tieredRegistry.ts";

test("SPB Governance: injects autoRecoveryDirective into pure tool_result user messages", async () => {
  const sessionId = "test-session-tool-result-directive-" + Date.now();

  // Build a conversation where the last message is a user message containing ONLY tool_result blocks
  const baseMessages: Array<{ role: string; content?: unknown }> = [
    {
      role: "user",
      content: "Please read the files and fix the issue.",
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_read_1",
          name: "Read",
          input: { file_path: "src/index.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_read_1",
          content: "file content 1",
        },
      ],
    },
  ];

  // Make multiple calls to accumulate consecutiveReads >= 2
  // First call: consecutiveReads = 1 (no stagnation yet)
  const result1 = await processSmartProxyRouting({
    sessionId,
    messages: baseMessages,
  });
  assert.ok(result1, "First call should succeed");

  // Second call: consecutiveReads = 2 (stagnation should be detected)
  // Pass the actual array reference so mutations propagate
  const messages2: Array<{ role: string; content?: unknown }> = [
    ...baseMessages,
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_read_2",
          name: "Read",
          input: { file_path: "src/index.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_read_2",
          content: "file content 2",
        },
      ],
    },
  ];

  const result2 = await processSmartProxyRouting({
    sessionId,
    messages: messages2,
  });
  assert.ok(result2, "Second call should succeed");

  // Check enhancedMessages or the mutated messages:
  // In SPB, enhancedMessages receives the injected directive and is returned to the router
  const targetMessages = result2.enhancedMessages || messages2;
  const lastUserMsg = targetMessages[targetMessages.length - 1];
  assert.ok(Array.isArray(lastUserMsg.content), "Content should be array");

  const hasDirectiveTextBlock = (lastUserMsg.content as Array<Record<string, unknown>>).some(
    (part) =>
      part &&
      part.type === "text" &&
      typeof part.text === "string" &&
      (part.text.includes("EXECUTION MANDATE") ||
        part.text.includes("DUPLICATE INSPECTION BLOCKED"))
  );

  assert.equal(
    hasDirectiveTextBlock,
    true,
    "The autoRecoveryDirective must be prepended as a text block on pure tool_result user turns"
  );
});

test("SPB Stagnation Registry: does not reset consecutiveReads to 0 upon detection", () => {
  const existingCheckpoint = {
    consecutiveReads: 3,
    modelTier: "tier_3_local",
  };

  const recovery = detectAndRecoverFromStagnation(
    "test-session-preservation",
    "INSPECTION_SYNTHESIS",
    3,
    existingCheckpoint
  );

  assert.equal(recovery.isStagnant, true);
  assert.equal(recovery.escalationTier, "tier_2_resilient");
  // The consecutiveReads in existingCheckpoint must NOT have been reset to 0
  assert.equal(
    existingCheckpoint.consecutiveReads,
    3,
    "consecutiveReads must be preserved upon detection to prevent alternating-turn oscillation"
  );
});
