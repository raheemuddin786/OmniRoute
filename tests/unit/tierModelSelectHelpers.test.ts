import test from "node:test";
import assert from "node:assert/strict";
import {
  isLocalEngineProvider,
  detectModelCapabilities,
  detectComboCapabilities,
  isModelEligibleForTier,
  matchesCapabilityFilter,
  getTierColorClass,
} from "../../src/shared/components/tierModelSelectHelpers";

test("isLocalEngineProvider identifies local runtimes and private endpoints", () => {
  assert.equal(isLocalEngineProvider("ollama-local"), true);
  assert.equal(isLocalEngineProvider("lm-studio"), true);
  assert.equal(isLocalEngineProvider("vllm"), true);
  assert.equal(isLocalEngineProvider("localai"), true);
  assert.equal(isLocalEngineProvider("jan"), true);
  assert.equal(isLocalEngineProvider("mlx-gemma"), true);
  assert.equal(isLocalEngineProvider("openai-compatible", "http://localhost:11434/v1"), true);
  assert.equal(isLocalEngineProvider("openai-compatible", "http://127.0.0.1:8000/v1"), true);

  // Cloud providers should be false
  assert.equal(isLocalEngineProvider("openai"), false);
  assert.equal(isLocalEngineProvider("anthropic"), false);
  assert.equal(isLocalEngineProvider("cohere"), false);
});

test("detectModelCapabilities correctly identifies apex, resilient, and local capabilities", () => {
  // Apex Reasoning model
  const o1Model = detectModelCapabilities("openai", {
    id: "o1-preview",
    name: "o1 Preview",
    supportsReasoning: true,
  });
  assert.equal(o1Model.isApexReasoning, true);

  const claude37 = detectModelCapabilities("anthropic", {
    id: "claude-3-7-sonnet",
    name: "Claude 3.7 Sonnet",
  });
  assert.equal(claude37.isApexReasoning, true);

  const deepseekR1 = detectModelCapabilities("deepseek", {
    id: "deepseek-reasoner",
    name: "DeepSeek R1",
  });
  assert.equal(deepseekR1.isApexReasoning, true);

  // Resilient Execution model
  const gpt4oMini = detectModelCapabilities("openai", {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    toolCalling: true,
  });
  assert.equal(gpt4oMini.isResilient, true);
  assert.equal(gpt4oMini.hasToolCalling, true);

  // Local Engine model
  const llamaLocal = detectModelCapabilities("ollama-local", {
    id: "llama-3-8b-instruct",
    name: "Llama 3 8B Instruct",
  });
  assert.equal(llamaLocal.isLocalEngine, true);
});

test("isModelEligibleForTier enforces strict tier filtering", () => {
  const apexCaps = {
    isApexReasoning: true,
    isResilient: false,
    isLocalEngine: false,
    hasToolCalling: true,
    hasVision: false,
  };

  const resilientCaps = {
    isApexReasoning: false,
    isResilient: true,
    isLocalEngine: false,
    hasToolCalling: true,
    hasVision: true,
  };

  const localCaps = {
    isApexReasoning: false,
    isResilient: false,
    isLocalEngine: true,
    hasToolCalling: false,
    hasVision: false,
  };

  // Tier 1 Apex: only accepts apex models
  assert.equal(isModelEligibleForTier("apex", apexCaps), true);
  assert.equal(isModelEligibleForTier("apex", resilientCaps), false);
  assert.equal(isModelEligibleForTier("apex", localCaps), false);

  // Tier 2 Resilient: accepts resilient tool-calling models
  assert.equal(isModelEligibleForTier("resilient", resilientCaps), true);
  assert.equal(isModelEligibleForTier("resilient", localCaps), false);

  // Tier 3 Local: accepts only local engine models
  assert.equal(isModelEligibleForTier("local", localCaps), true);
  assert.equal(isModelEligibleForTier("local", apexCaps), false);
  assert.equal(isModelEligibleForTier("local", resilientCaps), false);
});

test("matchesCapabilityFilter filters by specific operational capabilities", () => {
  const visionToolCaps = {
    isApexReasoning: false,
    isResilient: true,
    isLocalEngine: false,
    hasToolCalling: true,
    hasVision: true,
  };

  assert.equal(matchesCapabilityFilter("all", visionToolCaps, "resilient"), true);
  assert.equal(matchesCapabilityFilter("vision", visionToolCaps, "resilient"), true);
  assert.equal(matchesCapabilityFilter("tools", visionToolCaps, "resilient"), true);
  assert.equal(matchesCapabilityFilter("apex", visionToolCaps, "resilient"), false);
  assert.equal(matchesCapabilityFilter("local", visionToolCaps, "resilient"), false);
});

test("getTierColorClass returns distinct styling tokens for all 3 tiers", () => {
  const apex = getTierColorClass("apex");
  const resilient = getTierColorClass("resilient");
  const local = getTierColorClass("local");

  assert.equal(apex.accent, "indigo");
  assert.equal(resilient.accent, "blue");
  assert.equal(local.accent, "emerald");
});

test("detectComboCapabilities correctly qualifies edge, fast, free, and local combos for Tier 3", () => {
  // Fast agentic combo with flash and free models
  const fastCombo = detectComboCapabilities({
    id: "agentic-code-fast",
    name: "agentic-code-fast",
    strategy: "priority",
    models: [
      "antigravity/gemini-3.8-flash-low",
      "kilocode/stepfun/step-3.7-flash:free",
      "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    ],
  });
  assert.equal(fastCombo.isLocalEngine, true);
  assert.equal(isModelEligibleForTier("local", fastCombo), true);

  // Free accuracy combo
  const freeCombo = detectComboCapabilities({
    id: "rashizun/free-agentic-accuracy",
    name: "rashizun/free-agentic-accuracy",
    strategy: "priority",
    models: ["cline/deepseek/deepseek-v4-flash", "kilocode/kilo-auto/free"],
  });
  assert.equal(freeCombo.isLocalEngine, true);
  assert.equal(isModelEligibleForTier("local", freeCombo), true);

  // Combo with local model family
  const qwenGemmaCombo = detectComboCapabilities({
    id: "my-coding-pair",
    name: "my-coding-pair",
    strategy: "priority",
    models: ["ollama/qwen2.5-coder:32b", "nvidia/google/gemma-4-31b-it"],
  });
  assert.equal(qwenGemmaCombo.isLocalEngine, true);
  assert.equal(isModelEligibleForTier("local", qwenGemmaCombo), true);
});
