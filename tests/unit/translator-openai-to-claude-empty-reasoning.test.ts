import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.ts";

test("openai-to-claude ignores zero-length reasoning_content empty string deltas", () => {
  const state = {
    messageStartSent: true,
    thinkingBlockStarted: false,
    thinkingBlockIndex: -1,
    textBlockStarted: false,
    textBlockIndex: -1,
    textBlockClosed: false,
    nextBlockIndex: 0,
    _pendingXmlToolCalls: [],
  };

  const chunk = {
    choices: [
      {
        delta: {
          reasoning_content: "",
        },
      },
    ],
  };

  const results = openaiToClaudeResponse(chunk, state) || [];
  assert.equal(results.length, 0);
  assert.equal(state.thinkingBlockStarted, false);
});

test("openai-to-claude promotes accumulated reasoning to text content block when finish_reason arrives with zero text or tool calls", () => {
  const state = {
    messageStartSent: true,
    thinkingBlockStarted: false,
    thinkingBlockIndex: -1,
    textBlockStarted: false,
    textBlockIndex: -1,
    textBlockClosed: false,
    nextBlockIndex: 0,
    toolCalls: new Map(),
    _pendingXmlToolCalls: [],
  };

  const chunk1 = {
    choices: [
      {
        delta: {
          reasoning_content: "Thinking about solving the problem step by step.",
        },
      },
    ],
  };

  const results1 = openaiToClaudeResponse(chunk1, state) || [];
  assert.equal(
    results1.some((r) => r.type === "content_block_start" && r.content_block?.type === "thinking"),
    true
  );

  const chunk2 = {
    choices: [
      {
        delta: {},
        finish_reason: "stop",
      },
    ],
  };

  const results2 = openaiToClaudeResponse(chunk2, state) || [];
  const textStart = results2.find(
    (r) => r.type === "content_block_start" && r.content_block?.type === "text"
  );
  const textDelta = results2.find(
    (r) => r.type === "content_block_delta" && r.delta?.type === "text_delta"
  );
  assert.ok(textStart, "Should have created a text content_block_start fallback");
  assert.equal(textDelta.delta.text, "Thinking about solving the problem step by step.");
});
