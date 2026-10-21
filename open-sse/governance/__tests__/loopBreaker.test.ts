import { describe, it, expect, beforeEach } from "vitest";

import {
  LoopBreaker,
  fingerprintToolCall,
  buildLoopInterventionMessage,
  WINDOW_SIZE,
  REPEAT_THRESHOLD,
  PINGPONG_THRESHOLD,
  MAX_INTERVENTIONS,
} from "../loopBreaker.ts";

describe("loop breaker", () => {
  let breaker: LoopBreaker;

  beforeEach(() => {
    breaker = new LoopBreaker();
  });

  describe("fingerprint", () => {
    it("is stable across key order in the arguments", () => {
      const a = fingerprintToolCall("read_file", { path: "a.txt", mode: "r" });
      const b = fingerprintToolCall("read_file", { mode: "r", path: "a.txt" });
      expect(a).toBe(b);
    });

    it("differs when the arguments differ meaningfully", () => {
      const a = fingerprintToolCall("read_file", { path: "a.txt" });
      const b = fingerprintToolCall("read_file", { path: "b.txt" });
      expect(a).not.toBe(b);
    });

    it("differs when the tool name differs", () => {
      const a = fingerprintToolCall("read_file", { path: "a.txt" });
      const b = fingerprintToolCall("write_file", { path: "a.txt" });
      expect(a).not.toBe(b);
    });

    it("handles a null argument set", () => {
      expect(() => fingerprintToolCall("t", null)).not.toThrow();
      expect(fingerprintToolCall("t", null)).toBeTruthy();
    });
  });

  describe("repeat detection", () => {
    it("does not fire below the threshold", () => {
      for (let i = 0; i < REPEAT_THRESHOLD - 1; i++) {
        expect(breaker.observe("s", "read_file", { p: 1 })).toBeNull();
      }
    });

    it("fires at the threshold with the repeat kind", () => {
      let detection = null;
      for (let i = 0; i < REPEAT_THRESHOLD; i++) {
        detection = breaker.observe("s", "read_file", { p: 1 });
      }
      expect(detection).not.toBeNull();
      expect(detection?.kind).toBe("repeat");
      expect(detection?.count).toBe(REPEAT_THRESHOLD);
    });

    it("does NOT fire when the same tool is called with DIFFERENT arguments", () => {
      expect(breaker.observe("s", "read_file", { p: 1 })).toBeNull();
      expect(breaker.observe("s", "read_file", { p: 2 })).toBeNull();
      expect(breaker.observe("s", "read_file", { p: 3 })).toBeNull();
    });

    it("counts across the whole window, not just consecutive calls", () => {
      // "a" recurs three times but NEVER twice in a row — the count is over
      // the window, not over a consecutive run.
      expect(breaker.observe("s", "a", { x: 1 })).toBeNull();
      expect(breaker.observe("s", "b", { x: 2 })).toBeNull();
      expect(breaker.observe("s", "c", { x: 3 })).toBeNull();
      expect(breaker.observe("s", "a", { x: 1 })).toBeNull();
      expect(breaker.observe("s", "b", { x: 2 })).toBeNull();
      const detection = breaker.observe("s", "a", { x: 1 });
      expect(detection?.kind).toBe("repeat");
      expect(detection?.count).toBe(REPEAT_THRESHOLD);
    });

    it("forgets calls that fall out of the sliding window", () => {
      for (let i = 0; i < WINDOW_SIZE; i++) {
        breaker.observe("s", `other_${i}`, { x: i });
      }
      // The window now holds only the recent calls, so the old fingerprint is
      // gone and a single repeat must NOT fire.
      expect(breaker.observe("s", "read_file", { p: 1 })).toBeNull();
      expect(breaker.observe("s", "read_file", { p: 1 })).toBeNull();
    });
  });

  describe("ping-pong detection", () => {
    it("fires on a strictly alternating pair", () => {
      let detection = null;
      for (let i = 0; i < PINGPONG_THRESHOLD + 1; i++) {
        detection = breaker.observe("s", i % 2 === 0 ? "a" : "b", { x: i % 2 });
      }
      expect(detection).not.toBeNull();
      expect(detection?.kind).toBe("pingpong");
    });

    it("is preferred over the repeat classification", () => {
      // A,B,A,B,A — A appears three times, but the run is a ping-pong, which
      // is the more specific signal and must win.
      let detection = null;
      for (let i = 0; i < 5; i++) {
        detection = breaker.observe("s", i % 2 === 0 ? "a" : "b", { x: i % 2 });
      }
      expect(detection?.kind).toBe("pingpong");
    });

    it("does not fire on three DISTINCT fingerprints", () => {
      expect(breaker.observe("s", "a", { x: 1 })).toBeNull();
      expect(breaker.observe("s", "b", { x: 2 })).toBeNull();
      expect(breaker.observe("s", "c", { x: 3 })).toBeNull();
      expect(breaker.observe("s", "a", { x: 1 })).toBeNull();
    });

    it("does not fire on a run that involves a third fingerprint", () => {
      expect(breaker.observe("s", "a", { x: 1 })).toBeNull();
      expect(breaker.observe("s", "b", { x: 2 })).toBeNull();
      expect(breaker.observe("s", "a", { x: 1 })).toBeNull();
      const detection = breaker.observe("s", "c", { x: 3 });
      expect(detection).toBeNull();
    });
  });

  describe("intervention escalation", () => {
    it("does not abort on the first detection", () => {
      let detection = null;
      for (let i = 0; i < REPEAT_THRESHOLD; i++) {
        detection = breaker.observe("s", "read_file", { p: 1 });
      }
      expect(detection?.shouldAbort).toBe(false);
      expect(detection?.interventions).toBe(1);
    });

    it("aborts only after the intervention budget is exhausted", () => {
      let detection = null;
      for (let i = 0; i < REPEAT_THRESHOLD * (MAX_INTERVENTIONS + 2); i++) {
        detection = breaker.observe("s", "read_file", { p: 1 });
      }
      expect(detection?.shouldAbort).toBe(true);
    });

    it("tracks the intervention count per session", () => {
      for (let i = 0; i < REPEAT_THRESHOLD; i++) breaker.observe("s1", "read_file", { p: 1 });
      expect(breaker.getInterventionCount("s1")).toBe(1);
      expect(breaker.getInterventionCount("s2")).toBe(0);
    });
  });

  describe("session isolation", () => {
    it("does not carry state across sessions", () => {
      for (let i = 0; i < REPEAT_THRESHOLD - 1; i++) breaker.observe("s1", "read_file", { p: 1 });
      expect(breaker.observe("s2", "read_file", { p: 1 })).toBeNull();
    });

    it("forgets a session on reset", () => {
      for (let i = 0; i < REPEAT_THRESHOLD; i++) breaker.observe("s", "read_file", { p: 1 });
      breaker.reset("s");
      expect(breaker.getInterventionCount("s")).toBe(0);
      expect(breaker.observe("s", "read_file", { p: 1 })).toBeNull();
    });
  });

  describe("bounded state", () => {
    it("evicts the least-recently-active session past the cap", () => {
      const small = new LoopBreaker({ maxSessions: 2 });
      small.observe("a", "t", {});
      small.observe("b", "t", {});
      small.observe("c", "t", {});
      expect(small.size).toBeLessThanOrEqual(2);
    });
  });

  describe("fail open", () => {
    it("returns null for an empty session id", () => {
      expect(breaker.observe("", "read_file", { p: 1 })).toBeNull();
    });

    it("never throws on a hostile argument value", () => {
      const hostile = {
        get boom(): string {
          throw new Error("nope");
        },
      };
      expect(() => breaker.observe("s", "t", hostile)).not.toThrow();
    });
  });

  describe("intervention message", () => {
    it("names the offending action for a repeat", () => {
      const message = buildLoopInterventionMessage({
        kind: "repeat",
        fingerprints: ["fp"],
        count: 3,
        interventions: 1,
        shouldAbort: false,
      });
      expect(message).toContain("Halt");
      expect(message).toContain("3 times");
    });

    it("describes the alternation for a ping-pong", () => {
      const message = buildLoopInterventionMessage({
        kind: "pingpong",
        fingerprints: ["a", "b"],
        count: 3,
        interventions: 1,
        shouldAbort: false,
      });
      expect(message).toContain("alternating loop");
    });
  });

  describe("strategy pivot after intervention (regression: false loop on document writing)", () => {
    it("does NOT flag subsequent different tool calls after an intervention", () => {
      // Model calls read_file 3 times -> triggers 1st intervention
      breaker.observe("session-1", "read_file", { path: "notes.txt" });
      breaker.observe("session-1", "read_file", { path: "notes.txt" });
      const firstDetection = breaker.observe("session-1", "read_file", { path: "notes.txt" });
      expect(firstDetection).not.toBeNull();
      expect(firstDetection?.kind).toBe("repeat");
      expect(firstDetection?.interventions).toBe(1);
      expect(firstDetection?.shouldAbort).toBe(false);

      // Model changes strategy and writes a document:
      const writeResult1 = breaker.observe("session-1", "write_file", {
        path: "report.md",
        content: "# Title\nSection 1",
      });
      expect(writeResult1).toBeNull();
      expect(breaker.getInterventionCount("session-1")).toBe(1);

      // Model writes another document or section:
      const writeResult2 = breaker.observe("session-1", "write_file", {
        path: "report.md",
        content: "# Title\nSection 1\nSection 2",
      });
      expect(writeResult2).toBeNull();
      expect(breaker.getInterventionCount("session-1")).toBe(1);

      // Model writes a third document with different path:
      const writeResult3 = breaker.observe("session-1", "write_file", {
        path: "summary.md",
        content: "All tasks completed.",
      });
      expect(writeResult3).toBeNull();
      expect(breaker.getInterventionCount("session-1")).toBe(1);
    });

    it("detects repeat only if the model repeats the new tool call >= repeatThreshold times", () => {
      // Repeat on tool A
      for (let i = 0; i < REPEAT_THRESHOLD; i++) {
        breaker.observe("session-2", "tool_a", { arg: 1 });
      }
      expect(breaker.getInterventionCount("session-2")).toBe(1);

      // Pivot to tool B
      expect(breaker.observe("session-2", "write_file", { doc: 1 })).toBeNull();
      expect(breaker.observe("session-2", "write_file", { doc: 1 })).toBeNull();

      // Third time calling tool B with identical args:
      const bDetection = breaker.observe("session-2", "write_file", { doc: 1 });
      expect(bDetection).not.toBeNull();
      expect(bDetection?.kind).toBe("repeat");
      expect(bDetection?.interventions).toBe(2);
      expect(bDetection?.shouldAbort).toBe(false);
    });
  });

  describe("environment variable configuration", () => {
    it("honours OMNIROUTE_GOVERNANCE_LOOP_ENABLED=false", () => {
      const original = process.env.OMNIROUTE_GOVERNANCE_LOOP_ENABLED;
      try {
        process.env.OMNIROUTE_GOVERNANCE_LOOP_ENABLED = "false";
        const disabledBreaker = new LoopBreaker();
        for (let i = 0; i < 10; i++) {
          expect(disabledBreaker.observe("s", "t", { x: 1 })).toBeNull();
        }
        expect(disabledBreaker.getInterventionCount("s")).toBe(0);
      } finally {
        if (original === undefined) delete process.env.OMNIROUTE_GOVERNANCE_LOOP_ENABLED;
        else process.env.OMNIROUTE_GOVERNANCE_LOOP_ENABLED = original;
      }
    });

    it("honours custom threshold and window overrides via env", () => {
      const origRepeat = process.env.OMNIROUTE_GOVERNANCE_LOOP_REPEAT_THRESHOLD;
      const origWindow = process.env.OMNIROUTE_GOVERNANCE_LOOP_WINDOW_SIZE;
      const origInterventions = process.env.OMNIROUTE_GOVERNANCE_LOOP_MAX_INTERVENTIONS;
      try {
        process.env.OMNIROUTE_GOVERNANCE_LOOP_REPEAT_THRESHOLD = "5";
        process.env.OMNIROUTE_GOVERNANCE_LOOP_WINDOW_SIZE = "20";
        process.env.OMNIROUTE_GOVERNANCE_LOOP_MAX_INTERVENTIONS = "1";

        const customBreaker = new LoopBreaker();
        // 4 calls should not trip
        for (let i = 0; i < 4; i++) {
          expect(customBreaker.observe("s", "t", { x: 1 })).toBeNull();
        }
        // 5th call trips repeat
        const d1 = customBreaker.observe("s", "t", { x: 1 });
        expect(d1).not.toBeNull();
        expect(d1?.count).toBe(5);
        expect(d1?.interventions).toBe(1);
        expect(d1?.shouldAbort).toBe(false);

        // 6th call trips second intervention, which exceeds maxInterventions (1)
        const d2 = customBreaker.observe("s", "t", { x: 1 });
        expect(d2?.shouldAbort).toBe(true);
      } finally {
        if (origRepeat === undefined) delete process.env.OMNIROUTE_GOVERNANCE_LOOP_REPEAT_THRESHOLD;
        else process.env.OMNIROUTE_GOVERNANCE_LOOP_REPEAT_THRESHOLD = origRepeat;
        if (origWindow === undefined) delete process.env.OMNIROUTE_GOVERNANCE_LOOP_WINDOW_SIZE;
        else process.env.OMNIROUTE_GOVERNANCE_LOOP_WINDOW_SIZE = origWindow;
        if (origInterventions === undefined)
          delete process.env.OMNIROUTE_GOVERNANCE_LOOP_MAX_INTERVENTIONS;
        else process.env.OMNIROUTE_GOVERNANCE_LOOP_MAX_INTERVENTIONS = origInterventions;
      }
    });
  });
});
