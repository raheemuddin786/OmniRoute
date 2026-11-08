/**
 * Tool-rejection ledger — the shared state between the egress detection and
 * the ingress enforcement of a rejected tool call.
 *
 * WHAT THESE TESTS PIN DOWN
 *
 *  1. `record()` returns true only on the FIRST sighting of a call id — that
 *     is what makes "audit exactly once per call" possible.
 *  2. `markAudited()` / `markEnforced()` return true only on the FIRST
 *     transition, so a second turn cannot write a second audit row.
 *  3. The ledger is bounded (oldest entry evicted first).
 *  4. An empty call id is never recorded — it could not be matched back to a
 *     request anyway.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  ToolRejectionLedger,
  MAX_LEDGER_ENTRIES,
  getToolRejectionLedger,
  recordToolRejection,
  buildRejectionKey,
} from "../toolRejectionLedger.ts";

beforeEach(() => {
  getToolRejectionLedger().clear();
});

describe("ToolRejectionLedger", () => {
  it("records a rejection once", () => {
    const ledger = new ToolRejectionLedger();
    expect(ledger.record("call_1", "read_file", "unknown_tool", "not declared")).toBe(true);
    expect(ledger.record("call_1", "read_file", "unknown_tool", "not declared")).toBe(false);
    expect(ledger.size).toBe(1);
  });

  it("stores the rejection details", () => {
    const ledger = new ToolRejectionLedger();
    ledger.record("call_1", "read_file", "invalid_arguments", "bad args");
    const entry = ledger.get("call_1");
    expect(entry?.name).toBe("read_file");
    expect(entry?.reason).toBe("invalid_arguments");
    expect(entry?.message).toBe("bad args");
    expect(entry?.audited).toBe(false);
    expect(entry?.enforced).toBe(false);
  });

  it("marks the audit exactly once", () => {
    const ledger = new ToolRejectionLedger();
    ledger.record("call_1", "read_file", "unknown_tool", "not declared");
    expect(ledger.markAudited("call_1")).toBe(true);
    expect(ledger.markAudited("call_1")).toBe(false);
    expect(ledger.get("call_1")?.audited).toBe(true);
  });

  it("marks the enforcement exactly once", () => {
    const ledger = new ToolRejectionLedger();
    ledger.record("call_1", "read_file", "unknown_tool", "not declared");
    expect(ledger.markEnforced("call_1")).toBe(true);
    expect(ledger.markEnforced("call_1")).toBe(false);
    expect(ledger.get("call_1")?.enforced).toBe(true);
  });

  it("returns false when marking an unknown call id", () => {
    const ledger = new ToolRejectionLedger();
    expect(ledger.markAudited("nope")).toBe(false);
    expect(ledger.markEnforced("nope")).toBe(false);
  });

  it("never records an empty call id", () => {
    const ledger = new ToolRejectionLedger();
    expect(ledger.record("", "read_file", "unknown_tool", "not declared")).toBe(false);
    expect(ledger.size).toBe(0);
  });

  it("reports whether a call id is known", () => {
    const ledger = new ToolRejectionLedger();
    ledger.record("call_1", "read_file", "unknown_tool", "not declared");
    expect(ledger.has("call_1")).toBe(true);
    expect(ledger.has("call_2")).toBe(false);
  });

  it("returns null for an unknown call id", () => {
    expect(new ToolRejectionLedger().get("nope")).toBeNull();
  });

  it("evicts the oldest entry when full", () => {
    let clock = 1_000;
    const ledger = new ToolRejectionLedger({ maxEntries: 2, now: () => clock });
    ledger.record("call_1", "a", "unknown_tool", "x");
    clock += 1;
    ledger.record("call_2", "b", "unknown_tool", "x");
    clock += 1;
    ledger.record("call_3", "c", "unknown_tool", "x");
    expect(ledger.size).toBe(2);
    expect(ledger.get("call_1")).toBeNull();
    expect(ledger.get("call_2")).not.toBeNull();
    expect(ledger.get("call_3")).not.toBeNull();
  });

  it("clears every entry", () => {
    const ledger = new ToolRejectionLedger();
    ledger.record("call_1", "a", "unknown_tool", "x");
    ledger.clear();
    expect(ledger.size).toBe(0);
    expect(ledger.get("call_1")).toBeNull();
  });

  it("defaults to the documented entry cap", () => {
    expect(MAX_LEDGER_ENTRIES).toBe(2_000);
  });
});

describe("process-wide ledger", () => {
  it("records through the module-level helper", () => {
    expect(recordToolRejection("call_1", "read_file", "unknown_tool", "not declared")).toBe(true);
    expect(recordToolRejection("call_1", "read_file", "unknown_tool", "not declared")).toBe(false);
    expect(getToolRejectionLedger().get("call_1")?.name).toBe("read_file");
  });
});

describe("session-scoped keys", () => {
  it("scopes a key to the session when a session id is present", () => {
    const key = buildRejectionKey("session-a", "call_1");
    expect(key).not.toBe("call_1");
    expect(key).toContain("call_1");
    expect(key).toContain("session-a");
  });

  it("falls back to the bare call id without a session id", () => {
    expect(buildRejectionKey("", "call_1")).toBe("call_1");
    expect(buildRejectionKey(null, "call_1")).toBe("call_1");
    expect(buildRejectionKey(undefined, "call_1")).toBe("call_1");
  });

  it("gives two sessions different keys for the same call id", () => {
    expect(buildRejectionKey("session-a", "call_1")).not.toBe(
      buildRejectionKey("session-b", "call_1")
    );
  });

  it("does not leak a rejection across sessions", () => {
    const ledger = new ToolRejectionLedger();
    ledger.record(buildRejectionKey("session-a", "call_1"), "read_file", "unknown_tool", "x");
    expect(ledger.get(buildRejectionKey("session-a", "call_1"))).not.toBeNull();
    // A DIFFERENT conversation that reuses the same call id must not resolve
    // to the other conversation's rejection.
    expect(ledger.get(buildRejectionKey("session-b", "call_1"))).toBeNull();
  });

  it("scopes the process-wide helper too", () => {
    expect(recordToolRejection("call_1", "read_file", "unknown_tool", "x", "session-a")).toBe(true);
    expect(getToolRejectionLedger().get(buildRejectionKey("session-a", "call_1"))?.name).toBe(
      "read_file"
    );
    expect(getToolRejectionLedger().get(buildRejectionKey("session-b", "call_1"))).toBeNull();
  });
});
