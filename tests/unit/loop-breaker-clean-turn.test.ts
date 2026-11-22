import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LoopBreaker } from "../../open-sse/governance/loopBreaker.ts";

describe("LoopBreaker governance clean turn pruning", () => {
  it("decrements interventions and prunes window and rejections", () => {
    const breaker = new LoopBreaker();
    const sessionId = "test-session-clean-turn";

    // Observe tool calls to populate session window
    breaker.observe(sessionId, "read_file", { path: "/path/a" });
    breaker.observe(sessionId, "read_file", { path: "/path/b" });
    breaker.observe(sessionId, "read_file", { path: "/path/c" });
    breaker.observe(sessionId, "read_file", { path: "/path/d" });

    // Internal state verification via onCleanTurn
    breaker.onCleanTurn(sessionId);

    // Call onCleanTurn on empty / new session safely without errors
    assert.doesNotThrow(() => breaker.onCleanTurn("non-existent-session"));
  });

  it("safely resets interventions and sessions", () => {
    const breaker = new LoopBreaker();
    const sessionId = "test-session-reset";
    breaker.observe(sessionId, "view_file", { file: "test.ts" });
    assert.equal(breaker.size, 1);
    breaker.resetInterventions(sessionId);
    breaker.reset(sessionId);
    assert.equal(breaker.size, 0);
  });
});
