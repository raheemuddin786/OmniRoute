import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../../open-sse/services/spb/intentAnalyzer.ts";
import { selectModelTier } from "../../open-sse/services/spb/tieredRegistry.ts";
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
import {
  detectComboCapabilities,
  isModelEligibleForTier,
} from "../../src/shared/components/tierModelSelectHelpers.ts";
import { normalizeComboStep } from "../../src/lib/combos/steps.ts";

// Close the DB handle after all tests so the native test runner does not hang.
test.after(() => {
  __resetSpbStateInitForTests();
  resetDbInstance();
});

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

test("SPB Tiered Registry uses custom configured models when provided", () => {
  const customModels = {
    apex: ["my-custom-apex-model"],
    resilient: ["my-custom-resilient-model"],
    local: ["my-custom-local-model"],
  };
  const tier1 = selectModelTier("ARCHITECTURAL_PLANNING", 0.9, customModels);
  assert.equal(tier1.tier, "tier_1_apex");
  assert.deepEqual(tier1.recommendedModels, ["my-custom-apex-model"]);

  const tier2 = selectModelTier("CODE_GENERATION", 0.5, customModels);
  assert.equal(tier2.tier, "tier_2_resilient");
  assert.deepEqual(tier2.recommendedModels, ["my-custom-resilient-model"]);

  const tier3 = selectModelTier("FAST_REFACTOR", 0.1, customModels);
  assert.equal(tier3.tier, "tier_3_local");
  assert.deepEqual(tier3.recommendedModels, ["my-custom-local-model"]);
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
  assert.equal(shouldTriggerZeroLossFallback(400), true);
  assert.equal(shouldTriggerZeroLossFallback(402), true);
  assert.equal(shouldTriggerZeroLossFallback(408), true);
  assert.equal(shouldTriggerZeroLossFallback(429), true);
  assert.equal(shouldTriggerZeroLossFallback(500), true);
  assert.equal(shouldTriggerZeroLossFallback(503), true);
  assert.equal(shouldTriggerZeroLossFallback(200), false);
  assert.equal(shouldTriggerZeroLossFallback(401), false);
});

test("SPB Proxy Bridge orchestration end-to-end flow with model continuity", async () => {
  const sessionId = "orchestration_test_" + Date.now();
  const messagesTurn1 = [
    { role: "user", content: "Refactor this typescript class and add unit tests." },
  ];
  const decision1 = await processSmartProxyRouting({
    sessionId,
    messages: messagesTurn1,
  });

  assert.ok(decision1.intent);
  assert.ok(decision1.tierAssignment);
  assert.equal(decision1.checkpointRestored, false);
  assert.ok(typeof decision1.selectedModel === "string" && decision1.selectedModel.length > 0);

  // Turn 2 with tool output resumption
  const messagesTurn2 = [
    ...messagesTurn1,
    { role: "assistant", content: "I will refactor." },
    { role: "user", content: "Now proceed to execute." },
  ];
  const decision2 = await processSmartProxyRouting({
    sessionId,
    messages: messagesTurn2,
  });

  assert.equal(decision2.checkpointRestored, true);
  // Model continuity: turn 2 selectedModel must match turn 1 selectedModel
  assert.equal(decision2.selectedModel, decision1.selectedModel);
});

test("SPB Intent Analyzer ensures promptAnchorHash is invariant across conversation turns", () => {
  const systemMsg = { role: "system", content: "You are an expert AI engineer." };
  const firstUserMsg = { role: "user", content: "Build a zero-loss proxy router." };

  const turn1 = classifyIntent([systemMsg, firstUserMsg]);

  // Turn 2 adds assistant response and next user turn
  const turn2 = classifyIntent([
    systemMsg,
    firstUserMsg,
    { role: "assistant", content: "I will help you build the zero-loss router." },
    { role: "user", content: "Now add tests for prompt anchor stability." },
  ]);

  // The anchor hash must match exactly across turns so cache checkpoints are restored
  assert.equal(turn1.promptAnchorHash, turn2.promptAnchorHash);
});

test("SPB Tiered Registry tool-calling guard forces Tier 2 if tools are present even for simple tasks", () => {
  // FAST_REFACTOR with 0.1 complexity would normally go to tier_3_local
  const tierWithoutTools = selectModelTier("FAST_REFACTOR", 0.1);
  assert.equal(tierWithoutTools.tier, "tier_3_local");

  // With requiresTools = true, it must guard against local model and upgrade to tier_2_resilient
  const tierWithTools = selectModelTier("FAST_REFACTOR", 0.1, undefined, true);
  assert.equal(tierWithTools.tier, "tier_2_resilient");

  test("SPB combo capabilities detection and tier categorization", () => {
    // 1. Apex combo with o3-mini member
    const apexCombo = {
      name: "deep-thinker",
      strategy: "priority",
      models: ["openai/o3-mini", "anthropic/claude-3-5-sonnet"],
      description: "Deep thinking combo",
    };
    const apexCaps = detectComboCapabilities(apexCombo);
    assert.equal(apexCaps.isApexReasoning, true);
    assert.equal(isModelEligibleForTier("apex", apexCaps), true);

    // 2. Resilient execution combo
    const resilientCombo = {
      name: "coder-swarm",
      strategy: "weighted",
      models: ["anthropic/claude-3-5-sonnet", "deepseek/deepseek-coder"],
      description: "Multi-model coding team",
    };
    const resilientCaps = detectComboCapabilities(resilientCombo);
    assert.equal(resilientCaps.isResilient, true);
    assert.equal(isModelEligibleForTier("resilient", resilientCaps), true);

    // 3. Local engine combo
    const localCombo = {
      name: "edge-inference",
      strategy: "priority",
      models: ["ollama/llama3:8b", "ollama/mistral:7b"],
      description: "Offline edge inference",
    };
    const localCaps = detectComboCapabilities(localCombo);
    assert.equal(localCaps.isLocalEngine, true);
    assert.equal(isModelEligibleForTier("local", localCaps), true);
  });

  test("SPB Tiered Registry correctly assigns custom configured combo models", () => {
    const customModels = {
      apex: ["combo/apex-reasoning-fleet", "o1-pro"],
      resilient: ["code-gen-fusion", "gpt-4o"],
      local: ["combo/edge-offline"],
    };

    const apexAssignment = selectModelTier("ARCHITECTURAL_PLANNING", 0.95, customModels);
    assert.equal(apexAssignment.tier, "tier_1_apex");
    assert.deepEqual(apexAssignment.recommendedModels, customModels.apex);

    const resilientAssignment = selectModelTier("CODE_GENERATION", 0.6, customModels);
    assert.equal(resilientAssignment.tier, "tier_2_resilient");
    assert.deepEqual(resilientAssignment.recommendedModels, customModels.resilient);

    const localAssignment = selectModelTier("FAST_REFACTOR", 0.1, customModels, false);
    assert.equal(localAssignment.tier, "tier_3_local");
    assert.deepEqual(localAssignment.recommendedModels, customModels.local);
  });

  test("SPB Combo Step Normalization cleanly expands combo references and combo/ prefixes", () => {
    const mockCombos = [
      { name: "apex-reasoning-fleet", models: ["openai/o1", "anthropic/claude-3-7-sonnet"] },
      {
        name: "code-gen-fusion",
        models: ["anthropic/claude-3-5-sonnet", "deepseek/deepseek-coder"],
      },
    ];

    // Normalized plain combo name
    const step1 = normalizeComboStep("code-gen-fusion", { allCombos: mockCombos });
    assert.ok(step1);
    assert.equal(step1.kind, "combo-ref");
    assert.equal((step1 as { comboName: string }).comboName, "code-gen-fusion");

    // Normalized combo/ prefixed reference
    const step2 = normalizeComboStep("combo/apex-reasoning-fleet", { allCombos: mockCombos });
    assert.ok(step2);
    assert.equal(step2.kind, "combo-ref");
    assert.equal((step2 as { comboName: string }).comboName, "apex-reasoning-fleet");

    // Object format with model: "combo/apex-reasoning-fleet"
    const step3 = normalizeComboStep(
      { model: "combo/apex-reasoning-fleet" },
      { allCombos: mockCombos }
    );
    assert.ok(step3);
    assert.equal(step3.kind, "combo-ref");
    assert.equal((step3 as { comboName: string }).comboName, "apex-reasoning-fleet");
  });

  assert.ok(tierWithTools.recommendedModels.length > 0);
});
