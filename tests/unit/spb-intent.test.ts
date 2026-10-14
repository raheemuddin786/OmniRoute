import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../../open-sse/services/spb/intentAnalyzer.ts";
import { selectModelTier } from "../../open-sse/services/spb/tieredRegistry.ts";
import {
  processSmartProxyRouting,
  shouldTriggerZeroLossFallback,
} from "../../open-sse/services/spb/proxyBridge.ts";
import { saveCheckpoint, getCheckpoint } from "../../src/lib/db/spbState.ts";

test("SPB Intent Analyzer classifies architectural planning correctly", () => {
  const profile = classifyIntent([
    {
      role: "user",
      content: "Design a distributed microservices architecture with zero-loss failover and Kafka.",
    },
  ]);
  assert.equal(profile.taskPhase, "ARCHITECTURAL_PLANNING");
  assert.ok(profile.complexityScore >= 0.8);
  assert.match(profile.promptAnchorHash, /^sha256:spb_/);
});

test("SPB Intent Analyzer classifies code generation and tools correctly", () => {
  const profile = classifyIntent(
    [
      {
        role: "user",
        content: "Write an async function in TypeScript using classes and interfaces.",
      },
    ],
    [{ name: "get_weather" }]
  );
  assert.equal(profile.taskPhase, "CODE_GENERATION");
  assert.equal(profile.requiresTools, true);
});

test("SPB Tiered Registry selects correct model tiers", () => {
  const tier1 = selectModelTier("ARCHITECTURAL_PLANNING", 0.9);
  assert.equal(tier1.tier, "tier_1_apex");
  assert.ok(tier1.recommendedModels.includes("claude-3-5-sonnet"));

  const tier3 = selectModelTier("FAST_REFACTOR", 0.1);
  assert.equal(tier3.tier, "tier_3_local");
  assert.ok(tier3.recommendedModels.includes("llama-3-8b-instruct"));
});

test("SPB State Checkpoint persistence and anchor retrieval", () => {
  const sessionId = "test_session_" + Date.now();
  const anchorHash = "sha256:spb_deadbeef12345678";

  saveCheckpoint({
    sessionId,
    promptAnchorHash: anchorHash,
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    statePayload: JSON.stringify({ turn: 1 }),
    createdAt: Date.now(),
  });

  const cp = getCheckpoint(sessionId);
  assert.notEqual(cp, null);
  assert.equal(cp?.promptAnchorHash, anchorHash);
  assert.equal(cp?.modelTier, "tier_2_resilient");
});

test("SPB Zero-Loss Fallback trigger classification", () => {
  assert.equal(shouldTriggerZeroLossFallback(429), true);
  assert.equal(shouldTriggerZeroLossFallback(503), true);
  assert.equal(shouldTriggerZeroLossFallback(200), false);
  assert.equal(shouldTriggerZeroLossFallback(401), false);
});

test("SPB Proxy Bridge orchestration end-to-end flow", async () => {
  const decision = await processSmartProxyRouting({
    sessionId: "orchestration_test_" + Date.now(),
    messages: [{ role: "user", content: "Refactor this typescript class and add unit tests." }],
  });

  assert.ok(decision.intent);
  assert.ok(decision.tierAssignment);
  assert.equal(typeof decision.checkpointRestored, "boolean");
});
