/**
 * chatCore governance ingress — the request-side enforcement, end to end.
 *
 * WHAT THESE TESTS PIN DOWN
 *
 *  1. A parked loop intervention is injected ONCE into the next turn's
 *     request, and then consumed.
 *  2. A rejected tool call's RESULT is rewritten on the next turn's request —
 *     the only place a rejection can actually reach the model.
 *  3. The input body is never mutated.
 *  4. A body with no recognisable carrier is returned UNCHANGED (fail OPEN).
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  applyGovernanceIngress,
  nextGovernanceTurnIndex,
  resetGovernanceTurnCounters,
} from "../../handlers/chatCore/governanceIngress.ts";
import { getLoopInterventionStore, registerLoopIntervention } from "../loopIntervention.ts";
import { getToolRejectionLedger } from "../toolRejectionLedger.ts";
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

beforeEach(() => {
  getLoopInterventionStore().clear();
  getToolRejectionLedger().clear();
  resetGovernanceTurnCounters();
});

describe("applyGovernanceIngress — loop intervention", () => {
  it("injects a parked intervention into the next turn's request", () => {
    registerLoopIntervention("session-under-test", "STOP REPEATING.");
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = applyGovernanceIngress({
      body,
      sessionId: "session-under-test",
      sourceFormat: FORMATS.OPENAI,
    });
    const messages = (out as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages.some((m) => m.content?.includes("STOP REPEATING."))).toBe(true);
  });

  it("consumes the intervention — it is injected only once", () => {
    registerLoopIntervention("session-under-test", "STOP REPEATING.");
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyGovernanceIngress({
      body,
      sessionId: "session-under-test",
      sourceFormat: FORMATS.OPENAI,
    });
    const second = applyGovernanceIngress({
      body,
      sessionId: "session-under-test",
      sourceFormat: FORMATS.OPENAI,
    });
    const messages = (second as { messages: Array<{ content: string }> }).messages;
    expect(messages.some((m) => m.content?.includes("STOP REPEATING."))).toBe(false);
  });

  it("does not touch a request of a DIFFERENT session", () => {
    registerLoopIntervention("session-a", "STOP REPEATING.");
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = applyGovernanceIngress({
      body,
      sessionId: "session-b",
      sourceFormat: FORMATS.OPENAI,
    });
    expect(out).toBe(body);
  });
});

describe("applyGovernanceIngress — tool-call rejection", () => {
  it("rewrites the result of a rejected call the client echoed back", () => {
    // The request carries the client's own tool catalog, which is what the
    // echoed call is validated against.
    const body = {
      ...catalog,
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
    const out = applyGovernanceIngress({
      body,
      sessionId: "session-under-test",
      sourceFormat: FORMATS.OPENAI,
    });
    const messages = (out as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[1].content).toContain("tool_error");
    expect(messages[1].content).not.toContain("the real result");
    // The input body is never mutated.
    expect(body.messages[1].content).toBe("the real result");
  });

  it("leaves the result of an accepted call untouched", () => {
    const body = {
      ...catalog,
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
    const out = applyGovernanceIngress({
      body,
      sessionId: "session-under-test",
      sourceFormat: FORMATS.OPENAI,
    });
    const messages = (out as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[1].content).toBe("the real result");
  });

  it("rewrites an Anthropic tool_result with is_error", () => {
    const body = {
      ...catalog,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "nope_tool", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "the real result" }],
        },
      ],
    };
    const out = applyGovernanceIngress({
      body,
      sessionId: "session-under-test",
      sourceFormat: FORMATS.CLAUDE,
    });
    const blocks = (out as { messages: Array<{ content: Array<Record<string, unknown>> }> })
      .messages[1].content;
    expect(blocks[0].is_error).toBe(true);
    expect(blocks[0].content).not.toBe("the real result");
  });

  it("rewrites a Responses function_call_output", () => {
    const body = {
      ...catalog,
      input: [
        { type: "function_call", call_id: "call_1", name: "nope_tool", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "the real result" },
      ],
    };
    const out = applyGovernanceIngress({
      body,
      sessionId: "session-under-test",
      sourceFormat: FORMATS.OPENAI_RESPONSES,
    });
    const items = (out as { input: Array<Record<string, unknown>> }).input;
    expect(items[1].output).toContain("error");
    expect(items[1].output).not.toBe("the real result");
  });
});

describe("nextGovernanceTurnIndex", () => {
  it("increments per session", () => {
    expect(nextGovernanceTurnIndex("s1")).toBe(1);
    expect(nextGovernanceTurnIndex("s1")).toBe(2);
    expect(nextGovernanceTurnIndex("s2")).toBe(1);
  });

  it("returns 0 for an empty session id", () => {
    expect(nextGovernanceTurnIndex("")).toBe(0);
  });
});

describe("applyGovernanceIngress — fail open", () => {
  it("returns the body UNCHANGED when the body is a hostile getter", () => {
    // A governance failure must never corrupt a user's request. The body
    // carries a getter that throws, so the identity resolution and the
    // enforcement both blow up internally — the ingress must swallow it and
    // hand the body back.
    const hostile = {
      get messages(): never {
        throw new Error("boom");
      },
    } as never;

    let out: unknown;
    expect(() => {
      out = applyGovernanceIngress({
        body: hostile,
        sessionId: "session-under-test",
        sourceFormat: FORMATS.OPENAI,
      });
    }).not.toThrow();
    expect(out).toBe(hostile);
  });

  it("returns the body UNCHANGED when the session id is empty", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = applyGovernanceIngress({ body, sessionId: "" });
    expect(out).toBe(body);
  });

  it("never throws on a null body", () => {
    expect(() =>
      applyGovernanceIngress({ body: null, sessionId: "session-under-test" })
    ).not.toThrow();
  });
});
