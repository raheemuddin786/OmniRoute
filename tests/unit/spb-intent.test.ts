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

import { saveTierConfig } from "../../src/lib/db/tierConfig.ts";
import { setTierConfig } from "../../open-sse/services/tierResolver.ts";
import { DEFAULT_TIER_CONFIG } from "../../open-sse/services/tierConfig.ts";

const testTierConfig = {
  ...DEFAULT_TIER_CONFIG,
  spbEnabled: true,
  tierModels: {
    apex: ["test-apex-1", "test-apex-2"],
    resilient: ["test-resilient-1", "test-resilient-2"],
    local: ["test-local-1", "test-local-2"],
  },
};

test.before(() => {
  saveTierConfig(testTierConfig);
  setTierConfig(testTierConfig);
});

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

test("SPB Intent Analyzer extracts array content blocks and isolates system prompt from triggering Tier 1", () => {
  const sysMsg = {
    role: "system",
    content:
      "You are an assistant. Architecture guidelines: adhere to clean microservices architecture.",
  };

  // 1. Array content with formatting task should be DETERMINISTIC_ROUTING (Tier 3)
  const formatProfile = classifyIntent([
    sysMsg,
    {
      role: "user",
      content: [{ type: "text", text: "Format this JSON into a clean markdown table" }],
    },
  ]);
  assert.equal(formatProfile.taskPhase, "DETERMINISTIC_ROUTING");

  // 2. Tool result with architecture keyword inside code should be CODE_GENERATION (Tier 2), NOT Tier 1
  const toolResultProfile = classifyIntent([
    sysMsg,
    {
      role: "user",
      content: [{ type: "tool_result", content: "workflow.add_edge('intake', 'architecture')" }],
    },
  ]);
  assert.equal(toolResultProfile.taskPhase, "CODE_GENERATION");
  assert.equal(toolResultProfile.requiresTools, true);

  // 3. User asking to fix architecture bug should be CODE_GENERATION (Tier 2), NOT Tier 1
  const fixArchProfile = classifyIntent([
    sysMsg,
    { role: "user", content: "Fix the bug in the architecture module auth.ts" },
  ]);
  assert.equal(fixArchProfile.taskPhase, "CODE_GENERATION");

  // 4. Refactoring request should be FAST_REFACTOR (Tier 3)
  const refactorProfile = classifyIntent([
    sysMsg,
    { role: "user", content: "Refactor this function to simplify nested if-else statements" },
  ]);
  assert.equal(refactorProfile.taskPhase, "FAST_REFACTOR");

  // 5. Explicit architecture planning should be ARCHITECTURAL_PLANNING (Tier 1)
  const archProfile = classifyIntent([
    sysMsg,
    {
      role: "user",
      content: "Architect a high-performance consensus algorithm with Raft and Paxos comparison.",
    },
  ]);
  assert.equal(archProfile.taskPhase, "ARCHITECTURAL_PLANNING");

  // 6. Plan mode indicators from agent environments should be ARCHITECTURAL_PLANNING (Tier 1)
  const planModeProfile = classifyIntent([
    sysMsg,
    {
      role: "user",
      content: "Enter plan mode: analyze requirements and formulate an implementation plan.",
    },
  ]);
  assert.equal(planModeProfile.taskPhase, "ARCHITECTURAL_PLANNING");

  // 7. Deep reasoning / synthesis requests should be ARCHITECTURAL_PLANNING (Tier 1)
  const reasoningProfile = classifyIntent([
    sysMsg,
    {
      role: "user",
      content: "Think deeply and perform a comparative analysis of the trade-offs.",
    },
  ]);
  assert.equal(reasoningProfile.taskPhase, "ARCHITECTURAL_PLANNING");
});

test("SPB Tiered Registry selects correct model tiers based on configuration", () => {
  const customModels = {
    apex: ["custom-apex"],
    resilient: ["custom-resilient"],
    local: ["custom-local"],
  };
  const tier1 = selectModelTier("ARCHITECTURAL_PLANNING", 0.9, customModels);
  assert.equal(tier1.tier, "tier_1_apex");
  assert.deepEqual(tier1.recommendedModels, ["custom-apex"]);

  const tier3 = selectModelTier("FAST_REFACTOR", 0.1, customModels);
  assert.equal(tier3.tier, "tier_3_local");
  assert.deepEqual(tier3.recommendedModels, ["custom-local"]);

  // Without configured models, recommendedModels is an empty array (no hardcoded fallback)
  const emptyTier = selectModelTier("ARCHITECTURAL_PLANNING", 0.9);
  assert.equal(emptyTier.tier, "tier_1_apex");
  assert.deepEqual(emptyTier.recommendedModels, []);
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
  const messagesTurn1 = [{ role: "user", content: "Write a typescript class to calculate hash." }];
  const decision1 = await processSmartProxyRouting({
    sessionId,
    messages: messagesTurn1,
  });

  assert.ok(decision1.intent);
  assert.equal(decision1.tierAssignment.tier, "tier_2_resilient");
  assert.equal(decision1.checkpointRestored, false);
  assert.ok(typeof decision1.selectedModel === "string" && decision1.selectedModel.length > 0);

  // Turn 2 with tool output resumption in same tier (tier 2) preserves model continuity
  const messagesTurn2 = [
    ...messagesTurn1,
    { role: "assistant", content: "I will write the code." },
    { role: "user", content: "Now write the unit tests for this class." },
  ];
  const decision2 = await processSmartProxyRouting({
    sessionId,
    messages: messagesTurn2,
  });

  assert.equal(decision2.checkpointRestored, true);
  assert.equal(decision2.tierAssignment.tier, "tier_2_resilient");
  // Model continuity: turn 2 selectedModel must match turn 1 selectedModel within tier 2
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
  const configuredModels = {
    apex: ["test-apex"],
    resilient: ["test-resilient"],
    local: ["test-local"],
  };
  // FAST_REFACTOR with 0.1 complexity without tools goes to tier_3_local
  const tierWithoutTools = selectModelTier("FAST_REFACTOR", 0.1, configuredModels);
  assert.equal(tierWithoutTools.tier, "tier_3_local");
  assert.deepEqual(tierWithoutTools.recommendedModels, ["test-local"]);

  // With requiresTools = true, it must guard against local model and upgrade to tier_2_resilient
  const tierWithTools = selectModelTier("FAST_REFACTOR", 0.1, configuredModels, true);
  assert.equal(tierWithTools.tier, "tier_2_resilient");
  assert.deepEqual(tierWithTools.recommendedModels, ["test-resilient"]);
});

test("SPB strictly adheres to tier boundaries across code gen, tests, refactor, and architecture", () => {
  // 1. Code generation with system prompt must NOT route to Tier 1
  const codeGenWithSystemPrompt = classifyIntent([
    {
      role: "system",
      content:
        "You are a helpful assistant in an autonomous system workflow with design pipelines.",
    },
    { role: "user", content: "Write a python function to compute fibonacci numbers." },
  ]);
  const codeTier = selectModelTier(
    codeGenWithSystemPrompt.taskPhase,
    codeGenWithSystemPrompt.complexityScore,
    undefined,
    codeGenWithSystemPrompt.requiresTools
  );
  assert.equal(codeGenWithSystemPrompt.taskPhase, "CODE_GENERATION");
  assert.equal(codeTier.tier, "tier_2_resilient");

  // 2. Large context (over 8000 tokens) for refactor must NOT force Tier 1
  const largeCodeContext = "const x = 1;\n".repeat(4000); // ~16000 chars => 4000+ tokens
  const largeRefactor = classifyIntent([
    {
      role: "user",
      content: "Refactor this code to clean up variable names:\n" + largeCodeContext,
    },
  ]);
  const refactorTier = selectModelTier(
    largeRefactor.taskPhase,
    largeRefactor.complexityScore,
    undefined,
    largeRefactor.requiresTools
  );
  assert.equal(largeRefactor.taskPhase, "FAST_REFACTOR");
  assert.equal(refactorTier.tier, "tier_3_local");

  // 3. Testing and verification must route to Tier 2
  const testIntent = classifyIntent([
    { role: "user", content: "Run the unit test suite and verify test assertions and coverage." },
  ]);
  const testTier = selectModelTier(testIntent.taskPhase, testIntent.complexityScore);
  assert.equal(testIntent.taskPhase, "TESTING_AND_VERIFICATION");
  assert.equal(testTier.tier, "tier_2_resilient");

  // 4. Deterministic formatting without tools must route to Tier 3
  const formatIntent = classifyIntent([
    { role: "user", content: "Format this json string and sort the keys." },
  ]);
  const formatTier = selectModelTier(formatIntent.taskPhase, formatIntent.complexityScore);
  assert.equal(formatIntent.taskPhase, "DETERMINISTIC_ROUTING");
  assert.equal(formatTier.tier, "tier_3_local");

  // 5. Explicit architectural planning must route to Tier 1
  const archIntent = classifyIntent([
    {
      role: "user",
      content:
        "Design a distributed system architecture with microservices and multi-tier failover.",
    },
  ]);
  const archTier = selectModelTier(archIntent.taskPhase, archIntent.complexityScore);
  assert.equal(archIntent.taskPhase, "ARCHITECTURAL_PLANNING");
  assert.equal(archTier.tier, "tier_1_apex");
});

test("SPB session transitions smoothly from Tier 1 planning to Tier 2 execution without Tier 1 lock", async () => {
  const sessionId = "tier_transition_test_" + Date.now();

  // Turn 1: Architectural Planning (Tier 1)
  const turn1 = await processSmartProxyRouting({
    sessionId,
    messages: [
      {
        role: "user",
        content: "Plan a distributed system architecture for high-throughput messaging.",
      },
    ],
  });
  assert.equal(turn1.tierAssignment.tier, "tier_1_apex");

  // Turn 2: Execution / Code Generation (Must transition to Tier 2, NOT trapped in Tier 1)
  const turn2 = await processSmartProxyRouting({
    sessionId,
    messages: [
      {
        role: "user",
        content: "Plan a distributed system architecture for high-throughput messaging.",
      },
      { role: "assistant", content: "Here is the architectural plan." },
      {
        role: "user",
        content: "Now write the TypeScript implementation code for the message queue consumer.",
      },
    ],
  });
  assert.equal(turn2.tierAssignment.tier, "tier_2_resilient");
  assert.equal(turn2.checkpointRestored, false); // Tier transition cleanly decouples from Tier 1 apex model

  // Turn 3: Refactor / Clean up (Must transition to Tier 3 Local, NOT trapped in Tier 1)
  const turn3 = await processSmartProxyRouting({
    sessionId,
    messages: [
      {
        role: "user",
        content: "Plan a distributed system architecture for high-throughput messaging.",
      },
      { role: "assistant", content: "Here is the architectural plan." },
      {
        role: "user",
        content: "Now write the TypeScript implementation code for the message queue consumer.",
      },
      { role: "assistant", content: "Here is the code." },
      { role: "user", content: "Refactor and format this code to clean up variable names." },
    ],
  });
  assert.equal(turn3.tierAssignment.tier, "tier_3_local");
});

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
