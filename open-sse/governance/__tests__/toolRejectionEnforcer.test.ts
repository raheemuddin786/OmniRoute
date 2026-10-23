/**
 * Tool-rejection enforcement — the INGRESS half of the tool-schema validator.
 *
 * WHY THIS EXISTS
 *
 * A response stream carries tool CALLS (the model asking), never tool RESULTS
 * (the client answering). So a rejection cannot be delivered by editing the
 * response stream — the client would execute the rejected call and the model
 * would receive whatever the client produced. The proxy's only lever is the
 * NEXT turn's request: the client echoes the assistant turn plus the tool
 * results back, and the proxy REPLACES the result of a rejected call with a
 * synthetic error result in the format's existing error shape.
 *
 * WHAT THESE TESTS PIN DOWN
 *
 *  1. The echoed tool calls are extracted from all three request shapes.
 *  2. The tool RESULT of a rejected call is rewritten, in the shape the repo's
 *     own request translators already use.
 *  3. The result of an ACCEPTED call is left alone.
 *  4. The audit happens ONCE per call, even though the call is seen on the
 *     egress AND on every subsequent turn's ingress.
 *  5. The input body is never mutated, and an unrecognised shape is returned
 *     UNCHANGED (fail OPEN).
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  extractEchoedToolCalls,
  applyToolCallRejections,
  enforceToolCallRejections,
  OPENAI_TOOL_ERROR_MARKER,
} from "../toolRejectionEnforcer.ts";
import { ToolRejectionLedger, buildRejectionKey } from "../toolRejectionLedger.ts";
import { FORMATS } from "../../translator/formats.ts";

const catalog = {
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ],
};

const context = {
  body: catalog,
  sessionId: "session-under-test",
  clientFormat: FORMATS.OPENAI,
};

beforeEach(() => {
  /* each test builds its own ledger */
});

describe("extractEchoedToolCalls", () => {
  it("extracts an OpenAI assistant tool call", () => {
    const body = {
      messages: [
        { role: "user", content: "read a.txt" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "file contents" },
      ],
    };
    const calls = extractEchoedToolCalls(body);
    expect(calls).toHaveLength(1);
    expect(calls[0].callId).toBe("call_1");
    expect(calls[0].name).toBe("read_file");
  });

  it("extracts an Anthropic assistant tool_use block", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } },
          ],
        },
      ],
    };
    const calls = extractEchoedToolCalls(body);
    expect(calls).toHaveLength(1);
    expect(calls[0].callId).toBe("toolu_1");
    expect(calls[0].name).toBe("read_file");
  });

  it("extracts a Responses function_call item", () => {
    const body = {
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"a.txt"}',
        },
      ],
    };
    const calls = extractEchoedToolCalls(body);
    expect(calls).toHaveLength(1);
    expect(calls[0].callId).toBe("call_1");
  });

  it("returns nothing for a body with no tool calls", () => {
    expect(extractEchoedToolCalls({ messages: [{ role: "user", content: "hi" }] })).toEqual([]);
  });

  it("returns nothing for a non-object body", () => {
    expect(extractEchoedToolCalls(null)).toEqual([]);
    expect(extractEchoedToolCalls("nope")).toEqual([]);
  });

  it("skips a tool call with no name", () => {
    const body = {
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_1", function: { arguments: "{}" } }] },
      ],
    };
    expect(extractEchoedToolCalls(body)).toEqual([]);
  });
});

describe("applyToolCallRejections", () => {
  it("rewrites an OpenAI tool result with the repo's error marker", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "nope_tool", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "the real result" },
      ],
    };
    const rejections = new Map([
      ["call_1", { message: "not declared", reason: "unknown_tool" as const }],
    ]);
    const out = applyToolCallRejections(body, rejections);
    const messages = (out as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[1].content).toContain(OPENAI_TOOL_ERROR_MARKER);
    expect(messages[1].content).toContain("not declared");
    expect(messages[1].content).not.toContain("the real result");
    // The input body is untouched.
    expect(body.messages[1].content).toBe("the real result");
  });

  it("is idempotent and does not duplicate prefix if content already has OPENAI_TOOL_ERROR_MARKER", () => {
    const existingMarker = `${OPENAI_TOOL_ERROR_MARKER}\nalready rejected`;
    const body = {
      messages: [{ role: "tool", tool_call_id: "call_1", content: existingMarker }],
    };
    const rejections = new Map([
      ["call_1", { message: "already rejected", reason: "unknown_tool" as const }],
    ]);
    const out = applyToolCallRejections(body, rejections);
    expect(out).toBe(body);
    const messages = (out as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[0].content).toBe(existingMarker);
  });

  it("rewrites an Anthropic tool_result with is_error", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "the real result" }],
        },
      ],
    };
    const rejections = new Map([
      ["toolu_1", { message: "not declared", reason: "unknown_tool" as const }],
    ]);
    const out = applyToolCallRejections(body, rejections);
    const blocks = (out as { messages: Array<{ content: Array<Record<string, unknown>> }> })
      .messages[0].content;
    expect(blocks[0].is_error).toBe(true);
    expect(blocks[0].content).toBe("not declared");
  });

  it("rewrites a Responses function_call_output", () => {
    const body = {
      input: [
        { type: "function_call", call_id: "call_1", name: "nope_tool", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "the real result" },
      ],
    };
    const rejections = new Map([
      ["call_1", { message: "not declared", reason: "unknown_tool" as const }],
    ]);
    const out = applyToolCallRejections(body, rejections);
    const items = (out as { input: Array<Record<string, unknown>> }).input;
    expect(items[1].output).toBe(JSON.stringify({ error: "not declared" }));
  });

  it("leaves the result of an accepted call alone", () => {
    const body = {
      messages: [{ role: "tool", tool_call_id: "call_ok", content: "the real result" }],
    };
    const out = applyToolCallRejections(body, new Map());
    expect(out).toBe(body);
  });

  it("returns the body unchanged when no rejection matches", () => {
    const body = {
      messages: [{ role: "tool", tool_call_id: "call_ok", content: "the real result" }],
    };
    const rejections = new Map([["call_other", { message: "x", reason: "unknown_tool" as const }]]);
    expect(applyToolCallRejections(body, rejections)).toBe(body);
  });

  it("returns the body unchanged for an unrecognised shape", () => {
    const body = { prompt: "hello" };
    const rejections = new Map([["call_1", { message: "x", reason: "unknown_tool" as const }]]);
    expect(applyToolCallRejections(body, rejections)).toBe(body);
  });
});

describe("enforceToolCallRejections", () => {
  it("rewrites the result of a rejected call", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "nope_tool", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "the real result" },
      ],
    };
    const ledger = new ToolRejectionLedger();
    const { body: out, rejections } = enforceToolCallRejections(body, context, ledger);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].reason).toBe("unknown_tool");
    const messages = (out as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[1].content).toContain(OPENAI_TOOL_ERROR_MARKER);
  });

  it("leaves an accepted call's result untouched", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_ok",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_ok", content: "the real result" },
      ],
    };
    const ledger = new ToolRejectionLedger();
    const { body: out, rejections } = enforceToolCallRejections(body, context, ledger);
    expect(rejections).toHaveLength(0);
    expect(out).toBe(body);
    expect(ledger.size).toBe(0);
  });

  it("audits the rejection exactly once across repeated turns", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "nope_tool", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "the real result" },
      ],
    };
    const ledger = new ToolRejectionLedger();
    for (let turn = 0; turn < 3; turn++) {
      enforceToolCallRejections(body, context, ledger);
    }
    expect(ledger.size).toBe(1);
    expect(ledger.get(buildRejectionKey(context.sessionId, "call_1"))?.audited).toBe(true);
  });

  it("does not leak a rejection into another conversation that reuses the call id", () => {
    // A provider call id is unique only WITHIN one conversation. Two
    // conversations served by the same proxy routinely reuse short ids like
    // `call_1`.
    //
    // Conversation A declares a catalog WITHOUT `read_file`, so its call is
    // rejected and recorded. Conversation B DOES declare `read_file`, so its
    // call is legitimate — but with an unscoped ledger key, B finds A's
    // rejection and rewrites B's genuine tool result with a synthetic error.
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "the real result" },
      ],
    };
    // Conversation A: the catalog declares a DIFFERENT tool, so `read_file`
    // is an unknown tool there.
    const conversationA = {
      ...context,
      body: {
        tools: [
          {
            type: "function",
            function: { name: "write_file", parameters: { type: "object" } },
          },
        ],
      },
    };
    const ledger = new ToolRejectionLedger();
    const first = enforceToolCallRejections(body, conversationA, ledger);
    expect(first.rejections).toHaveLength(1);

    // Conversation B: `read_file` IS declared, so the call is legitimate.
    const conversationB = { ...context, sessionId: "a-different-conversation" };
    const { body: out, rejections } = enforceToolCallRejections(body, conversationB, ledger);
    expect(rejections).toHaveLength(0);
    expect(out).toBe(body);
    const messages = (out as { messages: Array<{ content: string }> }).messages;
    expect(messages[1].content).toBe("the real result");
  });

  it("still enforces the rejection inside the conversation that produced it", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "nope_tool", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "the real result" },
      ],
    };
    const ledger = new ToolRejectionLedger();
    enforceToolCallRejections(body, context, ledger);
    const { body: out, rejections } = enforceToolCallRejections(body, context, ledger);
    expect(rejections).toHaveLength(1);
    const messages = (out as { messages: Array<{ content: string }> }).messages;
    expect(messages[1].content).toContain(OPENAI_TOOL_ERROR_MARKER);
  });

  it("still rewrites the result on a later turn after the audit was written", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "nope_tool", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "the real result" },
      ],
    };
    const ledger = new ToolRejectionLedger();
    const first = enforceToolCallRejections(body, context, ledger);
    const second = enforceToolCallRejections(body, context, ledger);
    expect(first.rejections).toHaveLength(1);
    expect(second.rejections).toHaveLength(1);
    const messages = (second.body as { messages: Array<{ content: string }> }).messages;
    expect(messages[1].content).toContain(OPENAI_TOOL_ERROR_MARKER);
  });

  it("returns the body unchanged when there are no echoed tool calls", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const ledger = new ToolRejectionLedger();
    const { body: out, rejections } = enforceToolCallRejections(body, context, ledger);
    expect(out).toBe(body);
    expect(rejections).toEqual([]);
  });

  it("never leaks a stack trace into the rewritten result", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "nope_tool", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "the real result" },
      ],
    };
    const ledger = new ToolRejectionLedger();
    const { body: out } = enforceToolCallRejections(body, context, ledger);
    const messages = (out as { messages: Array<{ content: string }> }).messages;
    expect(messages[1].content).not.toContain("at /");
  });
});
