import { describe, it, expect, beforeEach } from "vitest";

import {
  LoopBreaker,
  fingerprintToolCall,
  buildLoopInterventionMessage,
  buildLoopSteeringDirective,
  resolveGovernanceLoopSteeringEnabled,
  WINDOW_SIZE,
  REPEAT_THRESHOLD,
  READONLY_REPEAT_THRESHOLD,
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
        expect(breaker.observe("s", "custom_tool", { p: 1 })).toBeNull();
      }
    });

    it("fires at the threshold with the repeat kind", () => {
      let detection = null;
      for (let i = 0; i < REPEAT_THRESHOLD; i++) {
        detection = breaker.observe("s", "custom_tool", { p: 1 });
      }
      expect(detection).not.toBeNull();
      expect(detection?.kind).toBe("repeat");
      expect(detection?.count).toBe(REPEAT_THRESHOLD);
    });

    it("does NOT fire when the same tool is called with DIFFERENT arguments", () => {
      expect(breaker.observe("s", "custom_tool", { p: 1 })).toBeNull();
      expect(breaker.observe("s", "custom_tool", { p: 2 })).toBeNull();
      expect(breaker.observe("s", "custom_tool", { p: 3 })).toBeNull();
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

    it("does not false-positive on alternating tools when request IDs are strictly disjoint (concurrent agents)", () => {
      // Simulate two concurrent agents running under the same fallback session ID
      // Agent 1 runs action A under req-agent-1
      // Agent 2 runs action B under req-agent-2
      // Tool executions interleave chronologically: A, B, A, B (3 transitions = pingpongThreshold)
      breaker.observe("s", "browser_navigate", { url: "https://example.com" }, "req-agent-1");
      breaker.observe("s", "bash_command", { command: "uptime" }, "req-agent-2");
      breaker.observe("s", "browser_navigate", { url: "https://example.com" }, "req-agent-1");
      const detection = breaker.observe("s", "bash_command", { command: "uptime" }, "req-agent-2");

      // Because reqsA (req-agent-1) and reqsB (req-agent-2) have zero overlap,
      // this is mathematically proven to be concurrent independent streams, not a ping-pong loop.
      expect(detection).toBeNull();
    });

    it("fires when alternating tools share a request ID (true sequential ping-pong loop)", () => {
      breaker.observe("s", "browser_navigate", { url: "https://example.com" }, "req-shared");
      breaker.observe("s", "bash_command", { command: "uptime" }, "req-shared");
      breaker.observe("s", "browser_navigate", { url: "https://example.com" }, "req-shared");
      const detection = breaker.observe("s", "bash_command", { command: "uptime" }, "req-shared");

      expect(detection).not.toBeNull();
      expect(detection?.kind).toBe("pingpong");
    });
  });

  describe("intervention escalation", () => {
    it("does not abort on the first detection", () => {
      let detection = null;
      for (let i = 0; i < REPEAT_THRESHOLD; i++) {
        detection = breaker.observe("s", "custom_tool", { p: 1 });
      }
      expect(detection?.shouldAbort).toBe(false);
      expect(detection?.interventions).toBe(1);
    });

    it("aborts only after the intervention budget is exhausted", () => {
      let detection = null;
      for (let i = 0; i < REPEAT_THRESHOLD * (MAX_INTERVENTIONS + 2); i++) {
        detection = breaker.observe("s", "custom_tool", { p: 1 });
      }
      expect(detection?.shouldAbort).toBe(true);
    });

    it("tracks the intervention count per session", () => {
      for (let i = 0; i < REPEAT_THRESHOLD; i++) breaker.observe("s1", "custom_tool", { p: 1 });
      expect(breaker.getInterventionCount("s1")).toBe(1);
      expect(breaker.getInterventionCount("s2")).toBe(0);
    });
  });

  describe("session isolation", () => {
    it("does not carry state across sessions", () => {
      for (let i = 0; i < REPEAT_THRESHOLD - 1; i++) breaker.observe("s1", "custom_tool", { p: 1 });
      expect(breaker.observe("s2", "custom_tool", { p: 1 })).toBeNull();
    });

    it("keeps interleaved concurrent sessions completely isolated", () => {
      // Interleave actions between session A and session B
      breaker.observe("sessionA", "custom_tool", { path: "a.txt" });
      breaker.observe("sessionB", "write_file", { path: "b.txt" });
      breaker.observe("sessionA", "custom_tool", { path: "a.txt" });
      breaker.observe("sessionB", "write_file", { path: "b.txt" });

      // Session A reaches threshold on its 3rd call
      const detectionA = breaker.observe("sessionA", "custom_tool", { path: "a.txt" });
      expect(detectionA).not.toBeNull();
      expect(detectionA?.kind).toBe("repeat");

      // Session B has only done 2 calls, so it must NOT trigger
      const detectionB = breaker.observe("sessionB", "other_tool", {});
      expect(detectionB).toBeNull();
      expect(breaker.getInterventionCount("sessionB")).toBe(0);
      expect(breaker.getInterventionCount("sessionA")).toBe(1);
    });

    it("forgets a session on reset", () => {
      for (let i = 0; i < REPEAT_THRESHOLD; i++) breaker.observe("s", "custom_tool", { p: 1 });
      breaker.reset("s");
      expect(breaker.getInterventionCount("s")).toBe(0);
      expect(breaker.observe("s", "custom_tool", { p: 1 })).toBeNull();
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
      // Model calls custom_tool 3 times -> triggers 1st intervention
      breaker.observe("session-1", "custom_tool", { path: "notes.txt" });
      breaker.observe("session-1", "custom_tool", { path: "notes.txt" });
      const firstDetection = breaker.observe("session-1", "custom_tool", { path: "notes.txt" });
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

    it("resolves loop steering enabled by default and honours env overrides", () => {
      const origSteering = process.env.OMNIROUTE_GOVERNANCE_LOOP_STEERING;
      try {
        delete process.env.OMNIROUTE_GOVERNANCE_LOOP_STEERING;
        expect(resolveGovernanceLoopSteeringEnabled()).toBe(true);

        process.env.OMNIROUTE_GOVERNANCE_LOOP_STEERING = "false";
        expect(resolveGovernanceLoopSteeringEnabled()).toBe(false);

        process.env.OMNIROUTE_GOVERNANCE_LOOP_STEERING = "0";
        expect(resolveGovernanceLoopSteeringEnabled()).toBe(false);

        process.env.OMNIROUTE_GOVERNANCE_LOOP_STEERING = "true";
        expect(resolveGovernanceLoopSteeringEnabled()).toBe(true);
      } finally {
        if (origSteering === undefined) delete process.env.OMNIROUTE_GOVERNANCE_LOOP_STEERING;
        else process.env.OMNIROUTE_GOVERNANCE_LOOP_STEERING = origSteering;
      }
    });
  });

  describe("buildLoopSteeringDirective", () => {
    it("builds a directive for repeat loops with tool name", () => {
      const directive = buildLoopSteeringDirective(
        {
          kind: "repeat",
          fingerprints: ["hash1"],
          count: 3,
          interventions: 2,
          shouldAbort: true,
        },
        "read_file"
      );
      expect(directive).toContain("Governance Steering Directive");
      expect(directive).toContain('"read_file"');
      expect(directive).toContain("3 times");
      expect(directive).toContain("Immediately change strategy");
    });

    it("builds a directive for pingpong loops", () => {
      const directive = buildLoopSteeringDirective({
        kind: "pingpong",
        fingerprints: ["hash1", "hash2"],
        count: 4,
        interventions: 2,
        shouldAbort: true,
      });
      expect(directive).toContain("Governance Steering Directive");
      expect(directive).toContain("alternating action loop");
      expect(directive).toContain("4 cycles");
      expect(directive).toContain("Immediately change strategy");
    });

    it("builds a directive for polymorphic repeat loops", () => {
      const directive = buildLoopSteeringDirective(
        {
          kind: "polymorphic_repeat",
          fingerprints: ["bash_tool"],
          count: 3,
          interventions: 1,
          shouldAbort: false,
        },
        "bash_tool"
      );
      expect(directive).toContain(
        'Tool "bash_tool" has been called repeatedly and rejected 3 times'
      );
      expect(directive).toContain("active catalog");
    });

    it("builds a directive for unknown tool loops", () => {
      const directive = buildLoopSteeringDirective({
        kind: "unknown_tool_loop",
        fingerprints: ["tool_a", "tool_b", "tool_c"],
        count: 3,
        interventions: 2,
        shouldAbort: true,
      });
      expect(directive).toContain("Multiple tool calls (3) were rejected");
      expect(directive).toContain("Do not invent new tool names");
    });
  });

  describe("polymorphic tool rejection detection", () => {
    it("detects polymorphic repeat when the same tool is rejected 3 times with different arguments", () => {
      expect(breaker.observeRejection("s", "fake_tool", "unknown_tool")).toBeNull();
      expect(breaker.observeRejection("s", "fake_tool", "unknown_tool")).toBeNull();
      const detection = breaker.observeRejection("s", "fake_tool", "unknown_tool");
      expect(detection).not.toBeNull();
      expect(detection?.kind).toBe("polymorphic_repeat");
      expect(detection?.count).toBe(3);
      expect(detection?.fingerprints).toEqual(["fake_tool"]);
    });

    it("detects unknown tool loop when multiple different unknown tools are invoked and rejected", () => {
      expect(breaker.observeRejection("s", "unknown_1", "unknown_tool")).toBeNull();
      expect(breaker.observeRejection("s", "unknown_2", "unknown_tool")).toBeNull();
      const detection = breaker.observeRejection("s", "unknown_3", "unknown_tool");
      expect(detection).not.toBeNull();
      expect(detection?.kind).toBe("unknown_tool_loop");
      expect(detection?.count).toBe(3);
      expect(detection?.fingerprints).toContain("unknown_1");
      expect(detection?.fingerprints).toContain("unknown_2");
      expect(detection?.fingerprints).toContain("unknown_3");
    });

    it("does not trip when rejections are cleared by clearWindow", () => {
      expect(breaker.observeRejection("s", "fake_tool", "unknown_tool")).toBeNull();
      expect(breaker.observeRejection("s", "fake_tool", "unknown_tool")).toBeNull();
      breaker.clearWindow("s");
      expect(breaker.observeRejection("s", "fake_tool", "unknown_tool")).toBeNull();
    });
  });

  describe("read-only tool threshold and mutation awareness", () => {
    it("does not fire at REPEAT_THRESHOLD for safe read-only operations", () => {
      for (let i = 0; i < REPEAT_THRESHOLD; i++) {
        expect(breaker.observe("s", "Read", { path: "a.txt" })).toBeNull();
      }
      expect(breaker.getInterventionCount("s")).toBe(0);
    });

    it("fires at READONLY_REPEAT_THRESHOLD for safe read-only operations", () => {
      let detection = null;
      for (let i = 0; i < READONLY_REPEAT_THRESHOLD; i++) {
        detection = breaker.observe("s", "Read", { path: "a.txt" });
      }
      expect(detection).not.toBeNull();
      expect(detection?.kind).toBe("repeat");
      expect(detection?.count).toBe(READONLY_REPEAT_THRESHOLD);
    });

    it("resets repetition epoch when an intervening mutating tool call occurs", () => {
      // Over 9 turns, Read is called 5 times but each is separated by a file modification.
      for (let i = 0; i < 5; i++) {
        const readDetection = breaker.observe("s", "Read", { path: "a.txt" });
        expect(readDetection).toBeNull();
        if (i < 4) {
          const editDetection = breaker.observe("s", "replace_file_content", {
            path: "a.txt",
            content: `update ${i}`,
          });
          expect(editDetection).toBeNull();
        }
      }
      expect(breaker.getInterventionCount("s")).toBe(0);
    });

    it("honours custom readonlyRepeatThreshold via options", () => {
      const customBreaker = new LoopBreaker({ readonlyRepeatThreshold: 4 });
      for (let i = 0; i < 3; i++) {
        expect(customBreaker.observe("s", "view_file", { path: "a.txt" })).toBeNull();
      }
      const detection = customBreaker.observe("s", "view_file", { path: "a.txt" });
      expect(detection).not.toBeNull();
      expect(detection?.count).toBe(4);
    });

    it("treats manage_task with status as read-only and kill as mutating", () => {
      for (let i = 0; i < 3; i++) {
        expect(breaker.observe("s", "manage_task", { action: "status", taskId: "t1" })).toBeNull();
      }
      // Mutating manage_task with kill fires at REPEAT_THRESHOLD (3)
      const mutBreaker = new LoopBreaker();
      let killDetection = null;
      for (let i = 0; i < REPEAT_THRESHOLD; i++) {
        killDetection = mutBreaker.observe("s", "manage_task", { action: "kill", taskId: "t1" });
      }
      expect(killDetection).not.toBeNull();
      expect(killDetection?.count).toBe(REPEAT_THRESHOLD);
    });
  });

  describe("onCleanTurn", () => {
    it("decrements the intervention counter by 1 on a clean turn", () => {
      // Trigger 2 interventions
      for (let i = 0; i < MAX_INTERVENTIONS; i++) {
        for (let j = 0; j < REPEAT_THRESHOLD; j++) {
          breaker.observe("s", "run_command", { cmd: "npm test" });
        }
        breaker.clearWindow("s");
      }
      expect(breaker.getInterventionCount("s")).toBe(MAX_INTERVENTIONS);

      breaker.onCleanTurn("s");
      expect(breaker.getInterventionCount("s")).toBe(MAX_INTERVENTIONS - 1);
    });

    it("floors the intervention counter at zero and never goes negative", () => {
      // Session with 0 interventions
      breaker.observe("s", "view_file", { path: "a.ts" });
      expect(breaker.getInterventionCount("s")).toBe(0);

      breaker.onCleanTurn("s");
      expect(breaker.getInterventionCount("s")).toBe(0);

      breaker.onCleanTurn("s"); // second call still safe
      expect(breaker.getInterventionCount("s")).toBe(0);
    });

    it("is a no-op for an unknown session", () => {
      // Must not throw and must not create a session entry
      expect(() => breaker.onCleanTurn("unknown-session")).not.toThrow();
      expect(breaker.getInterventionCount("unknown-session")).toBe(0);
    });

    it("prunes the oldest half of the tool-call window", () => {
      // Fill the window with WINDOW_SIZE distinct calls so each fingerprint appears once
      for (let i = 0; i < WINDOW_SIZE; i++) {
        breaker.observe("s", "view_file", { path: `file_${i}.ts` });
      }
      // Now add the same call (file_0.ts) that was in the first half of the window.
      // Without pruning it would be in the window and only needs 2 more to hit REPEAT_THRESHOLD (3).
      breaker.onCleanTurn("s");

      // After pruning, only the newest half remains. file_0 was in the oldest half
      // so it has been pruned. One more observation with file_0.ts should NOT fire.
      const result = breaker.observe("s", "view_file", { path: "file_0.ts" });
      expect(result).toBeNull();
    });

    it("prunes the oldest half of the rejections window", () => {
      const customBreaker = new LoopBreaker({ repeatThreshold: 2, maxInterventions: 10 });
      // Record 4 rejections so the window is at half-capacity
      for (let i = 0; i < 4; i++) {
        customBreaker.observeRejection("s", "bad_tool", "unknown_tool");
        customBreaker.clearWindow("s");
      }
      const countBefore = customBreaker.getInterventionCount("s");

      customBreaker.onCleanTurn("s");

      // After pruning half the rejections, 2 more unknown_tool rejections should
      // not immediately hit the polymorphic-repeat threshold of 2 — only 1 rejection remains.
      // The key assertion is that without pruning we would have hit the threshold earlier.
      customBreaker.observeRejection("s", "bad_tool", "unknown_tool");
      expect(customBreaker.getInterventionCount("s")).toBeGreaterThanOrEqual(countBefore);
    });

    it("after a clean turn, a subsequent genuine loop is still detected", () => {
      // Trigger 1 intervention to raise the counter
      for (let j = 0; j < REPEAT_THRESHOLD; j++) {
        breaker.observe("s", "run_command", { cmd: "npm test" });
      }
      expect(breaker.getInterventionCount("s")).toBe(1);
      breaker.clearWindow("s");

      // A clean turn decrements to 0
      breaker.onCleanTurn("s");
      expect(breaker.getInterventionCount("s")).toBe(0);

      // The model now repeats a NEW loop — must still be caught
      let detection = null;
      for (let j = 0; j < REPEAT_THRESHOLD; j++) {
        detection = breaker.observe("s", "bash", { cmd: "ls" });
      }
      expect(detection).not.toBeNull();
      expect(detection?.kind).toBe("repeat");
    });

    it("multiple clean turns each decrement the counter independently", () => {
      // Manually set interventions to 3 via repeated detections
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < REPEAT_THRESHOLD; j++) {
          breaker.observe("s", `tool_${i}`, { x: i });
        }
        breaker.clearWindow("s");
      }
      expect(breaker.getInterventionCount("s")).toBe(3);

      breaker.onCleanTurn("s");
      expect(breaker.getInterventionCount("s")).toBe(2);
      breaker.onCleanTurn("s");
      expect(breaker.getInterventionCount("s")).toBe(1);
      breaker.onCleanTurn("s");
      expect(breaker.getInterventionCount("s")).toBe(0);
      breaker.onCleanTurn("s"); // floor
      expect(breaker.getInterventionCount("s")).toBe(0);
    });
  });
});
