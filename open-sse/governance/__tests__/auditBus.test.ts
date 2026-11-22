import { describe, it, expect, beforeEach } from "vitest";

import {
  GovernanceAuditBus,
  canonicalizeJson,
  hashPromptMessages,
  type GovernanceAuditSink,
  registerGovernanceAuditSink,
  recordGovernanceAudit,
} from "../auditBus.ts";

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-1",
    turnIndex: 0,
    promptHash: "abc123",
    toolCallsRequested: ["read_file"],
    toolCallsExecuted: [],
    tokensIn: 10,
    tokensOut: 20,
    model: "gpt-4",
    provider: "openai",
    compressionApplied: false,
    ...overrides,
  } as never;
}

describe("governance audit bus", () => {
  let bus: GovernanceAuditBus;

  beforeEach(() => {
    bus = new GovernanceAuditBus({ capacity: 5 });
  });

  describe("normal flow", () => {
    it("records an entry and exposes it", () => {
      bus.record(baseRecord());
      expect(bus.stats.recorded).toBe(1);
      expect(bus.stats.size).toBe(1);
      const recent = bus.recent();
      expect(recent).toHaveLength(1);
      expect(recent[0].sessionId).toBe("sess-1");
      expect(recent[0].toolCallsRequested).toEqual(["read_file"]);
    });

    it("never stores prompt or response CONTENT", () => {
      bus.record(baseRecord({ promptHash: "deadbeef" }));
      const entry = bus.recent()[0];
      // The record shape has no content field at all — assert the serialized
      // form carries only the hash and the counters.
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain("messages");
      expect(serialized).not.toContain("content");
      expect(serialized).not.toContain('prompt"');
      expect(entry.promptHash).toBe("deadbeef");
    });

    it("fans out to registered sinks synchronously without awaiting", () => {
      const seen: string[] = [];
      const sink: GovernanceAuditSink = {
        name: "test",
        record: (record) => {
          seen.push(record.sessionId);
        },
      };
      const unsubscribe = bus.registerSink(sink);
      bus.record(baseRecord());
      expect(seen).toEqual(["sess-1"]);

      unsubscribe();
      bus.record(baseRecord({ sessionId: "sess-2" }));
      expect(seen).toEqual(["sess-1"]);
    });

    it("isolates a throwing sink and keeps recording", () => {
      const good: string[] = [];
      bus.registerSink({
        name: "bad",
        record: () => {
          throw new Error("sink exploded");
        },
      });
      bus.registerSink({ name: "good", record: (r) => good.push(r.sessionId) });

      expect(() => bus.record(baseRecord())).not.toThrow();
      expect(good).toEqual(["sess-1"]);
      expect(bus.stats.failedCount).toBe(1);
      // The record still landed in the ring buffer.
      expect(bus.stats.size).toBe(1);
    });
  });

  describe("edge case — ring-buffer overflow", () => {
    it("counts overflow and dropped records instead of silently discarding", () => {
      for (let i = 0; i < 8; i++) {
        bus.record(baseRecord({ turnIndex: i }));
      }
      const stats = bus.stats;
      expect(stats.capacity).toBe(5);
      expect(stats.size).toBe(5);
      expect(stats.recorded).toBe(8);
      expect(stats.overflowCount).toBe(3);
      expect(stats.droppedCount).toBe(3);
    });

    it("keeps the NEWEST entries after overflow", () => {
      for (let i = 0; i < 8; i++) {
        bus.record(baseRecord({ turnIndex: i }));
      }
      const turns = bus.recent().map((r) => r.turnIndex);
      expect(turns).toEqual([7, 6, 5, 4, 3]);
    });
  });

  describe("fail open", () => {
    it("never throws when the record input is malformed", () => {
      expect(() =>
        bus.record({
          sessionId: "s",
          turnIndex: 0,
          promptHash: "h",
          toolCallsRequested: undefined as never,
          toolCallsExecuted: undefined as never,
          tokensIn: 0,
          tokensOut: 0,
          model: "",
          provider: "",
          compressionApplied: false,
        })
      ).not.toThrow();
      expect(bus.stats.size).toBe(1);
    });

    it("counts and logs an internal failure without throwing", () => {
      const hostile = {
        sessionId: "s",
        turnIndex: 0,
        promptHash: "h",
        // A getter that throws — the bus must survive it.
        get toolCallsRequested(): string[] {
          throw new Error("boom");
        },
        toolCallsExecuted: [],
        tokensIn: 0,
        tokensOut: 0,
        model: "",
        provider: "",
        compressionApplied: false,
      } as never;

      expect(() => bus.record(hostile)).not.toThrow();
      expect(bus.stats.failedCount).toBe(1);
      expect(bus.stats.size).toBe(0);
    });
  });

  describe("prompt hashing", () => {
    it("is stable across key order in the message array", () => {
      const a = { messages: [{ role: "user", content: "hi" }] };
      const b = { messages: [{ content: "hi", role: "user" }] };
      expect(hashPromptMessages(a)).toBe(hashPromptMessages(b));
    });

    it("hashes the Responses `input` shape too, not only `messages`", () => {
      const responses = { input: [{ role: "user", content: "hi" }] };
      const chat = { messages: [{ role: "user", content: "hi" }] };
      // Both shapes must produce a hash (the Responses body must not no-op).
      expect(hashPromptMessages(responses)).toBeTruthy();
      expect(hashPromptMessages(responses)).not.toBe(hashPromptMessages(chat));
    });

    it("produces different hashes for different content", () => {
      const a = { messages: [{ role: "user", content: "one" }] };
      const b = { messages: [{ role: "user", content: "two" }] };
      expect(hashPromptMessages(a)).not.toBe(hashPromptMessages(b));
    });

    it("canonicalizes nested objects recursively", () => {
      const canonical = canonicalizeJson({ b: 1, a: { d: 2, c: 3 } }) as Record<string, unknown>;
      expect(Object.keys(canonical)).toEqual(["a", "b"]);
      expect(Object.keys(canonical.a as Record<string, unknown>)).toEqual(["c", "d"]);
    });

    it("drops undefined object entries like JSON.stringify does", () => {
      const canonical = canonicalizeJson({ a: 1, b: undefined }) as Record<string, unknown>;
      expect(Object.keys(canonical)).toEqual(["a"]);
    });
  });
});

describe("process-wide audit bus", () => {
  it("registers a RoutingEventSink-shaped sink and fans out to it", () => {
    const seen: string[] = [];
    const unsubscribe = registerGovernanceAuditSink({
      name: "process-wide-test",
      record: (record) => {
        seen.push(record.sessionId);
      },
    });
    try {
      recordGovernanceAudit({
        sessionId: "sess-pw",
        turnIndex: 0,
        promptHash: "h",
        toolCallsRequested: [],
        toolCallsExecuted: [],
        tokensIn: 0,
        tokensOut: 0,
        model: "m",
        provider: "p",
        compressionApplied: false,
      });
      expect(seen).toEqual(["sess-pw"]);
    } finally {
      unsubscribe();
    }
  });

  it("stops fanning out after the sink unsubscribes", () => {
    const seen: string[] = [];
    const unsubscribe = registerGovernanceAuditSink({
      name: "process-wide-test-2",
      record: (record) => {
        seen.push(record.sessionId);
      },
    });
    unsubscribe();
    recordGovernanceAudit({
      sessionId: "sess-pw-2",
      turnIndex: 0,
      promptHash: "h",
      toolCallsRequested: [],
      toolCallsExecuted: [],
      tokensIn: 0,
      tokensOut: 0,
      model: "m",
      provider: "p",
      compressionApplied: false,
    });
    expect(seen).toEqual([]);
  });
});
