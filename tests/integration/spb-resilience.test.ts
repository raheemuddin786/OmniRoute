import test from "node:test";
import assert from "node:assert/strict";
import {
  processSmartProxyRouting,
  shouldTriggerZeroLossFallback,
} from "../../open-sse/services/spb/proxyBridge.ts";
import {
  saveCheckpoint,
  getCheckpoint,
  __resetSpbStateInitForTests,
} from "../../src/lib/db/spbState.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

// Close the DB handle after all tests so the native test runner does not hang.
test.after(() => {
  __resetSpbStateInitForTests();
  resetDbInstance();
});

test("SPB Integration: Zero-loss resilience and state resumption across mock failover", async () => {
  const sessionId = "integration_session_" + Date.now();
  const messages = [
    { role: "system", content: "You are an autonomous engineering agent." },
    {
      role: "user",
      content:
        "Implement a fault-tolerant circuit breaker in TypeScript with class and async methods.",
    },
  ];

  // 1. Initial routing decision & checkpoint creation
  const decision1 = await processSmartProxyRouting({ sessionId, messages });
  assert.equal(decision1.intent.taskPhase, "CODE_GENERATION");
  assert.equal(decision1.checkpointRestored, false);

  // 2. Simulate upstream failure (e.g. HTTP 503 or 429)
  const failedStatusCode = 503;
  assert.equal(shouldTriggerZeroLossFallback(failedStatusCode), true);

  // 3. Explicitly save and verify checkpoint state before recovery
  const testCheckpoint = {
    sessionId,
    promptAnchorHash: decision1.intent.promptAnchorHash,
    taskPhase: decision1.intent.taskPhase,
    modelTier: decision1.tierAssignment.tier,
    statePayload: JSON.stringify({ recovered: true, turn: 2 }),
    createdAt: Date.now(),
  };
  saveCheckpoint(testCheckpoint);

  const checkpoint = getCheckpoint(sessionId);
  assert.notEqual(checkpoint, null);
  assert.equal(checkpoint?.promptAnchorHash, decision1.intent.promptAnchorHash);
  assert.match(checkpoint?.statePayload ?? "", /recovered/);

  // 4. Simulate fallback request execution with restored session state
  const decision2 = await processSmartProxyRouting({ sessionId, messages });
  assert.equal(decision2.intent.promptAnchorHash, decision1.intent.promptAnchorHash);
  assert.equal(decision2.checkpointRestored, true);
});
