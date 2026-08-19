import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeOpenAIResponse,
  sanitizeResponsesApiResponse,
} from "../../open-sse/handlers/responseSanitizer.ts";

test("sanitizeOpenAIResponse promotes reasoning_content to content when content is empty and no tool calls exist", () => {
  const input = {
    id: "chatcmpl-test1",
    object: "chat.completion",
    created: 1234567890,
    model: "deepseek-r1",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          reasoning_content: "I will read the code file line by line to analyze the root cause.",
        },
        finish_reason: "stop",
      },
    ],
  };

  const sanitized = sanitizeOpenAIResponse(input) as Record<string, unknown>;
  const choices = sanitized.choices as Array<Record<string, unknown>>;
  const message = choices[0].message as Record<string, unknown>;

  assert.equal(
    message.content,
    "I will read the code file line by line to analyze the root cause."
  );
  assert.equal(
    message.reasoning_content,
    "I will read the code file line by line to analyze the root cause."
  );
});

test("sanitizeOpenAIResponse preserves tool_calls and does not promote reasoning_content over tool calls", () => {
  const input = {
    id: "chatcmpl-test2",
    object: "chat.completion",
    created: 1234567890,
    model: "deepseek-r1",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          reasoning_content: "I am calling the file search tool.",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "search_files", arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };

  const sanitized = sanitizeOpenAIResponse(input) as Record<string, unknown>;
  const choices = sanitized.choices as Array<Record<string, unknown>>;
  const message = choices[0].message as Record<string, unknown>;

  assert.equal(message.content, "");
  assert.ok(Array.isArray(message.tool_calls));
  assert.equal((message.tool_calls as unknown[]).length, 1);
});

test("sanitizeResponsesApiResponse promotes reasoning_content to output_text when converting to responses format", () => {
  const input = {
    id: "chatcmpl-test3",
    object: "chat.completion",
    created: 1234567890,
    model: "stepfun-3.7",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          reasoning_content: "Analyzing existing imports and architecture.",
        },
        finish_reason: "stop",
      },
    ],
  };

  const sanitized = sanitizeResponsesApiResponse(input) as Record<string, unknown>;
  const output = sanitized.output as Array<Record<string, unknown>>;

  assert.ok(Array.isArray(output));
  const messageItem = output.find((item) => item.type === "message");
  assert.ok(messageItem, "Expected a message item in output array");
  const content = messageItem!.content as Array<Record<string, unknown>>;
  assert.equal(content[0].text, "Analyzing existing imports and architecture.");
});
