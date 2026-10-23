import { describe, it, expect, beforeEach } from "vitest";

import {
  validateToolCall,
  buildRejectionResult,
  resetDegradedSessionLog,
  degradedSessionCount,
  MAX_DEGRADED_SESSIONS,
  type ToolCallValidationContext,
} from "../toolSchemaValidator.ts";
import { getGovernanceAuditBus } from "../auditBus.ts";

/**
 * The validator works against the request body's own `tools[]` catalog — the
 * same `tools[]` the client sent. The two catalog shapes it understands are
 * the ones the repo's `extractToolSchemaMap` / `collectDeclaredToolNames`
 * helpers already accept:
 *   - Chat Completions: `{type:"function", function:{name, parameters}}`
 *   - Responses API:   `{type:"function", name, parameters}`
 */

const context = (
  overrides: Partial<ToolCallValidationContext> = {}
): ToolCallValidationContext => ({
  body: {},
  sessionId: "sess-1",
  ...overrides,
});

describe("tool schema validator", () => {
  beforeEach(() => {
    resetDegradedSessionLog();
  });

  describe("catalog unavailable", () => {
    it("skips validation and reports DEGRADED when there is no tools[]", () => {
      const outcome = validateToolCall({ name: "read_file", arguments: "{}" }, context());
      expect(outcome.ok).toBe(true);
      if (outcome.ok !== true) return;
      expect(outcome.degraded).toBe(true);
    });

    it("does NOT reject a call whose name is absent from a missing catalog", () => {
      const outcome = validateToolCall({ name: "totally_unknown", arguments: {} }, context());
      expect(outcome.ok).toBe(true);
    });

    it("logs the DEGRADED event once per session, not per request", () => {
      const ctx = context({ sessionId: "sess-degraded" });
      validateToolCall({ name: "t", arguments: {} }, ctx);
      validateToolCall({ name: "t", arguments: {} }, ctx);
      validateToolCall({ name: "t", arguments: {} }, ctx);
      expect(degradedSessionCount()).toBe(1);
    });

    it("counts the DEGRADED sessions separately per session id", () => {
      validateToolCall({ name: "t", arguments: {} }, context({ sessionId: "a" }));
      validateToolCall({ name: "t", arguments: {} }, context({ sessionId: "b" }));
      expect(degradedSessionCount()).toBe(2);
    });

    it("bounds the DEGRADED dedup set", () => {
      for (let i = 0; i < MAX_DEGRADED_SESSIONS + 20; i++) {
        validateToolCall({ name: "t", arguments: {} }, context({ sessionId: `s${i}` }));
      }
      expect(degradedSessionCount()).toBeLessThanOrEqual(MAX_DEGRADED_SESSIONS);
    });
  });

  describe("unknown tool", () => {
    const body = {
      tools: [
        { type: "function", function: { name: "read_file", parameters: { type: "object" } } },
      ],
    };

    it("rejects a tool that is not in the catalog", () => {
      const outcome = validateToolCall({ name: "write_file", arguments: {} }, context({ body }));
      expect(outcome.ok).toBe(false);
      if (outcome.ok === true) return;
      expect(outcome.reason).toBe("unknown_tool");
      expect(outcome.message).toContain("write_file");
    });

    it("accepts a tool that IS in the catalog", () => {
      const outcome = validateToolCall(
        { name: "read_file", arguments: { path: "a" } },
        context({ body })
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok !== true) return;
      expect(outcome.degraded).toBe(false);
    });

    it("accepts the Responses flat tool shape", () => {
      const responsesBody = {
        tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
      };
      const outcome = validateToolCall(
        { name: "read_file", arguments: {} },
        context({ body: responsesBody })
      );
      expect(outcome.ok).toBe(true);
    });

    it("rejects a call with no name at all", () => {
      const outcome = validateToolCall({ name: "  ", arguments: {} }, context({ body }));
      expect(outcome.ok).toBe(false);
      if (outcome.ok === true) return;
      expect(outcome.reason).toBe("unknown_tool");
    });

    it("is NOT degraded when a catalog is present", () => {
      const outcome = validateToolCall({ name: "read_file", arguments: {} }, context({ body }));
      expect(outcome.ok).toBe(true);
      if (outcome.ok !== true) return;
      expect(outcome.degraded).toBe(false);
      expect(degradedSessionCount()).toBe(0);
    });
  });

  describe("argument schema validation", () => {
    const body = {
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

    it("rejects arguments that violate the schema", () => {
      const outcome = validateToolCall(
        { name: "read_file", arguments: { path: 42 } },
        context({ body })
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok === true) return;
      expect(outcome.reason).toBe("invalid_arguments");
    });

    it("rejects arguments that are missing a required property", () => {
      const outcome = validateToolCall({ name: "read_file", arguments: {} }, context({ body }));
      expect(outcome.ok).toBe(false);
      if (outcome.ok === true) return;
      expect(outcome.reason).toBe("invalid_arguments");
    });

    it("accepts arguments that satisfy the schema", () => {
      const outcome = validateToolCall(
        { name: "read_file", arguments: { path: "a.txt" } },
        context({ body })
      );
      expect(outcome.ok).toBe(true);
    });

    it("accepts arguments supplied as a JSON string", () => {
      const outcome = validateToolCall(
        { name: "read_file", arguments: '{"path":"a.txt"}' },
        context({ body })
      );
      expect(outcome.ok).toBe(true);
    });

    it("rejects malformed JSON arguments", () => {
      const outcome = validateToolCall(
        { name: "read_file", arguments: "{not json" },
        context({ body })
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok === true) return;
      expect(outcome.reason).toBe("malformed_arguments");
    });

    it("rejects oversized arguments marked on descriptor", () => {
      const outcome = validateToolCall(
        { name: "read_file", arguments: '{"path":"a.txt"}', oversized: true },
        context({ body })
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok === true) return;
      expect(outcome.reason).toBe("oversized_arguments");
      expect(outcome.message).toContain("maximum allowed size limit");
    });

    it("treats an empty argument string as an empty object", () => {
      const outcome = validateToolCall({ name: "read_file", arguments: "" }, context({ body }));
      // `{}` is missing the required `path` → rejected by the schema, but the
      // reason is the schema, not a JSON parse failure.
      expect(outcome.ok).toBe(false);
      if (outcome.ok === true) return;
      expect(outcome.reason).toBe("invalid_arguments");
    });

    it("does NOT validate arguments when the tool carries no schema", () => {
      const schemaLess = {
        tools: [{ type: "function", function: { name: "read_file" } }],
      };
      const outcome = validateToolCall(
        { name: "read_file", arguments: { whatever: true } },
        context({ body: schemaLess })
      );
      expect(outcome.ok).toBe(true);
    });

    it("fails OPEN when the schema itself cannot be compiled", () => {
      const brokenSchema = {
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              parameters: { type: "object", properties: 42 },
            },
          },
        ],
      };
      const outcome = validateToolCall(
        { name: "read_file", arguments: { anything: 1 } },
        context({ body: brokenSchema })
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok !== true) return;
      expect(outcome.degraded).toBe(false);
    });
  });

  describe("rejection result shape", () => {
    it("builds an Anthropic tool_result", () => {
      const result = buildRejectionResult(
        "claude",
        { name: "t", arguments: {}, callId: "toolu_1" },
        "nope"
      );
      expect(result).toEqual({
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "nope",
        is_error: true,
      });
    });

    it("builds a Responses function_call_output", () => {
      const result = buildRejectionResult(
        "openai-responses",
        { name: "t", arguments: {}, callId: "call_1" },
        "nope"
      );
      expect(result.type).toBe("function_call_output");
      expect(result.call_id).toBe("call_1");
      expect(String(result.output)).toContain("nope");
    });

    it("builds an OpenAI Chat tool message by default", () => {
      const result = buildRejectionResult(
        "openai",
        { name: "t", arguments: {}, callId: "call_1" },
        "nope"
      );
      expect(result).toEqual({
        role: "tool",
        tool_call_id: "call_1",
        content: "nope",
        is_error: true,
      });
    });

    it("uses an empty call id when the call has none", () => {
      const result = buildRejectionResult("openai", { name: "t", arguments: {} }, "nope");
      expect(result.tool_call_id).toBe("");
    });
  });

  describe("fail open", () => {
    it("never throws on a hostile body", () => {
      const hostile = {
        get tools(): never {
          throw new Error("boom");
        },
      };
      expect(() =>
        validateToolCall({ name: "t", arguments: {} }, context({ body: hostile }))
      ).not.toThrow();
    });

    it("never throws on a null call", () => {
      expect(() =>
        validateToolCall(null as unknown as { name: string; arguments: unknown }, context())
      ).not.toThrow();
    });
  });
});

describe("tool schema validator — DEGRADED is once per SESSION, not per request", () => {
  beforeEach(() => {
    resetDegradedSessionLog();
  });

  it("emits exactly ONE audit row for a session that stays catalog-less", () => {
    // A per-request DEGRADED log would flood the audit trail with one row
    // per turn of every tool-less session. The dedup is per session, so the
    // row count must stay at 1 no matter how many turns arrive.
    const bus = getGovernanceAuditBus();
    bus.clear();
    const before = bus.stats.recorded;

    const ctx = context({ sessionId: "sess-degraded-once" });
    for (let turn = 0; turn < 25; turn++) {
      const outcome = validateToolCall({ name: "read_file", arguments: {} }, ctx);
      expect(outcome.ok).toBe(true);
    }

    const rows = bus
      .recent(10_000)
      .filter(
        (r) => r.event === "tool_validation.degraded" && r.sessionId === "sess-degraded-once"
      );
    expect(rows).toHaveLength(1);
    expect(bus.stats.recorded - before).toBe(1);
  });

  it("emits ONE row per session when several sessions are catalog-less", () => {
    const bus = getGovernanceAuditBus();
    bus.clear();

    for (const sessionId of ["s1", "s2", "s3"]) {
      const ctx = context({ sessionId });
      validateToolCall({ name: "read_file", arguments: {} }, ctx);
      validateToolCall({ name: "read_file", arguments: {} }, ctx);
      validateToolCall({ name: "read_file", arguments: {} }, ctx);
    }

    const rows = bus.recent(10_000).filter((r) => r.event === "tool_validation.degraded");
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.sessionId)).size).toBe(3);
  });
});
