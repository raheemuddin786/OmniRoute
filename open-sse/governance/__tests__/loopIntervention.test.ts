/**
 * Loop intervention — the store and the format-aware injection.
 *
 * WHAT THESE TESTS PIN DOWN
 *
 *  1. The store is bounded (LRU eviction) and consumes each intervention
 *     EXACTLY ONCE — a parked intervention must not be re-injected on every
 *     subsequent turn.
 *  2. The injection picks the system carrier from the CLIENT FORMAT, not
 *     from the body shape: an Anthropic Messages body carries BOTH `system`
 *     and `messages[]`, so a shape-only detector would put the directive in
 *     the wrong place.
 *  3. The input body is never mutated.
 *  4. A body with no recognisable carrier is returned UNCHANGED (fail OPEN).
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  LoopInterventionStore,
  MAX_INTERVENTION_SESSIONS,
  getLoopInterventionStore,
  registerLoopIntervention,
  consumeLoopIntervention,
  peekLoopIntervention,
  injectGovernanceIntervention,
} from "../loopIntervention.ts";
import { FORMATS } from "../../translator/formats.ts";

const MESSAGE = "Stop repeating the same action.";

beforeEach(() => {
  getLoopInterventionStore().clear();
});

describe("LoopInterventionStore", () => {
  it("parks and consumes an intervention exactly once", () => {
    const store = new LoopInterventionStore();
    store.register("s1", MESSAGE);
    expect(store.peek("s1")).toBe(MESSAGE);
    expect(store.consume("s1")).toBe(MESSAGE);
    expect(store.consume("s1")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("replaces an older intervention for the same session", () => {
    const store = new LoopInterventionStore();
    store.register("s1", "first");
    store.register("s1", "second");
    expect(store.consume("s1")).toBe("second");
    expect(store.size).toBe(0);
  });

  it("ignores an empty session id or message", () => {
    const store = new LoopInterventionStore();
    store.register("", MESSAGE);
    store.register("s1", "");
    expect(store.size).toBe(0);
  });

  it("evicts the oldest entry when full", () => {
    let clock = 1_000;
    const store = new LoopInterventionStore({ maxSessions: 2, now: () => clock });
    store.register("s1", "a");
    clock += 1;
    store.register("s2", "b");
    clock += 1;
    // s1 is the oldest registration, so it is the one evicted.
    store.register("s3", "c");
    expect(store.size).toBe(2);
    expect(store.peek("s1")).toBeNull();
    expect(store.peek("s2")).toBe("b");
    expect(store.peek("s3")).toBe("c");
  });

  it("evicts by registration recency when an entry is re-registered", () => {
    let clock = 1_000;
    const store = new LoopInterventionStore({ maxSessions: 2, now: () => clock });
    store.register("s1", "a");
    clock += 1;
    store.register("s2", "b");
    clock += 1;
    // Re-registering s1 makes s2 the oldest entry.
    store.register("s1", "a2");
    clock += 1;
    store.register("s3", "c");
    expect(store.size).toBe(2);
    expect(store.peek("s2")).toBeNull();
    expect(store.peek("s1")).toBe("a2");
  });

  it("discards an intervention without reading it", () => {
    const store = new LoopInterventionStore();
    store.register("s1", MESSAGE);
    store.discard("s1");
    expect(store.peek("s1")).toBeNull();
  });

  it("defaults to the documented session cap", () => {
    expect(MAX_INTERVENTION_SESSIONS).toBe(500);
    expect(new LoopInterventionStore().size).toBe(0);
  });
});

describe("process-wide store", () => {
  it("registers, peeks and consumes through the module-level helpers", () => {
    registerLoopIntervention("s1", MESSAGE);
    expect(peekLoopIntervention("s1")).toBe(MESSAGE);
    expect(consumeLoopIntervention("s1")).toBe(MESSAGE);
    expect(consumeLoopIntervention("s1")).toBeNull();
  });
});

describe("injectGovernanceIntervention", () => {
  it("injects into an OpenAI system message", () => {
    const body = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ],
    };
    const out = injectGovernanceIntervention(body, MESSAGE, FORMATS.OPENAI);
    const messages = (out as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[0].content).toContain("You are helpful.");
    expect(messages[0].content).toContain(MESSAGE);
    // The input body is untouched.
    expect(body.messages[0].content).toBe("You are helpful.");
  });

  it("appends a system message when the OpenAI body has none", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = injectGovernanceIntervention(body, MESSAGE, FORMATS.OPENAI);
    const messages = (out as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("system");
    expect(messages[1].content).toBe(MESSAGE);
  });

  it("injects into the Anthropic top-level system field", () => {
    const body = {
      system: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
    };
    const out = injectGovernanceIntervention(body, MESSAGE, FORMATS.CLAUDE);
    expect((out as { system: string }).system).toContain("You are helpful.");
    expect((out as { system: string }).system).toContain(MESSAGE);
    // The `messages[]` array is NOT the Anthropic system carrier.
    expect((out as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it("injects into an Anthropic system block array", () => {
    const body = { system: [{ type: "text", text: "You are helpful." }] };
    const out = injectGovernanceIntervention(body, MESSAGE, FORMATS.CLAUDE);
    const system = (out as { system: Array<{ type: string; text: string }> }).system;
    expect(system).toHaveLength(2);
    expect(system[1].text).toBe(MESSAGE);
  });

  it("injects into the Responses `instructions` field", () => {
    const body = { instructions: "You are helpful.", input: [] };
    const out = injectGovernanceIntervention(body, MESSAGE, FORMATS.OPENAI_RESPONSES);
    expect((out as { instructions: string }).instructions).toContain(MESSAGE);
    expect((out as { instructions: string }).instructions).toContain("You are helpful.");
  });

  it("injects into the Gemini `systemInstruction.parts[]`", () => {
    const body = { systemInstruction: { parts: [{ text: "You are helpful." }] } };
    const out = injectGovernanceIntervention(body, MESSAGE, FORMATS.GEMINI);
    const parts = (out as { systemInstruction: { parts: Array<{ text: string }> } })
      .systemInstruction.parts;
    expect(parts).toHaveLength(2);
    expect(parts[1].text).toBe(MESSAGE);
  });

  it("uses the client format, not the body shape, to pick the carrier", () => {
    // An Anthropic body carries BOTH `system` and `messages[]`. With the
    // Claude format declared, the directive goes to `system`.
    const body = { system: "base", messages: [{ role: "user", content: "hi" }] };
    const out = injectGovernanceIntervention(body, MESSAGE, FORMATS.CLAUDE);
    expect((out as { system: string }).system).toContain(MESSAGE);
  });

  it("returns the body unchanged when no carrier is recognised", () => {
    const body = { prompt: "hello" };
    const out = injectGovernanceIntervention(body, MESSAGE, FORMATS.OPENAI);
    expect(out).toBe(body);
  });

  it("returns the body unchanged for an empty message", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = injectGovernanceIntervention(body, "", FORMATS.OPENAI);
    expect(out).toBe(body);
  });

  it("returns a non-object body unchanged", () => {
    const out = injectGovernanceIntervention("not a body", MESSAGE, FORMATS.OPENAI);
    expect(out).toBe("not a body");
  });

  it("preserves a block-array content shape on an OpenAI system message", () => {
    const body = {
      messages: [{ role: "system", content: [{ type: "text", text: "base" }] }],
    };
    const out = injectGovernanceIntervention(body, MESSAGE, FORMATS.OPENAI);
    const content = (out as { messages: Array<{ content: unknown[] }> }).messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({ type: "text", text: MESSAGE });
  });
});
