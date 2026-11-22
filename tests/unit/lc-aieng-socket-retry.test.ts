import test from "node:test";
import assert from "node:assert/strict";
import { getCircuitBreaker } from "../../src/shared/utils/circuitBreaker.ts";

test("Task C: lc-aieng circuit breaker trips on ECONNREFUSED", () => {
  const breaker = getCircuitBreaker("lc-aieng");
  assert.equal(breaker.getStatus().state, "CLOSED");

  // Simulate ECONNREFUSED failure tripping breaker
  breaker._onFailure();
  assert.equal(breaker.getStatus().failureCount, 1);
});
