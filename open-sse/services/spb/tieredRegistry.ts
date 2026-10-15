/**
 * SPB-IR Tiered Model Registry & Decision Engine
 * Maps classified task phases and complexity scores to dynamic model tiers
 * (Tier 1: Apex Reasoning, Tier 2: Resilient Execution, Tier 3: Local Edge Inference).
 */

import { TaskPhase } from "./intentAnalyzer.ts";

export type ModelTier = "tier_1_apex" | "tier_2_resilient" | "tier_3_local";

export interface TierConfig {
  providerOverrides: Array<{ provider: string; tier: ModelTier }>;
  tierWeights: Record<ModelTier, number>;
  cacheThreshold: number;
  fallbackTimeout: number;
}

export async function loadTierConfig(): Promise<TierConfig> {
  const config = (await loadTierConfigFromDb()) ?? {
    providerOverrides: [],
    tierWeights: { tier_1_apex: 0.3, tier_2_resilient: 0.5, tier_3_local: 0.2 },
    cacheThreshold: 5000,
    fallbackTimeout: 5000,
  };
  return config;
}

export async function saveTierConfig(config: TierConfig): Promise<void> {
  await saveTierConfig({
    key: "tier_config",
    value: JSON.stringify(config),
    updatedAt: Date.now(),
  });
  // Bust in-process cache
  await setTierConfig(config);
}

export async function loadTierConfigFromDb(): Promise<TierConfig | null> {
  const row = await getDbInstance()
    .prepare("SELECT value FROM tier_config WHERE key = 'tier_config'")
    .get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as TierConfig;
    // Validate shape
    if (
      !parsed.providerOverrides ||
      !parsed.tierWeights ||
      typeof parsed.cacheThreshold !== "number" ||
      typeof parsed.fallbackTimeout !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveTierConfigToDb(config: TierConfig): Promise<void> {
  await saveTierConfig({
    key: "tier_config",
    value: JSON.stringify(config),
    updatedAt: Date.now(),
  });
}

export async function getTierConfig(): Promise<TierConfig> {
  return await loadTierConfig();
}

export interface TierAssignment {
  tier: ModelTier;
  recommendedModels: string[];
  maxTokens: number;
  temperature: number;
  cacheEnabled: boolean;
}

export function selectModelTier(taskPhase: TaskPhase, complexityScore: number): TierAssignment {
  if (taskPhase === "ARCHITECTURAL_PLANNING" || complexityScore >= 0.85) {
    return {
      tier: "tier_1_apex",
      recommendedModels: ["claude-3-5-sonnet", "gpt-4o", "claude-opus-5-5"],
      maxTokens: 8192,
      temperature: 0.2,
      cacheEnabled: true,
    };
  }

  if (taskPhase === "FAST_REFACTOR" || taskPhase === "DETERMINISTIC_ROUTING") {
    if (complexityScore < 0.3) {
      return {
        tier: "tier_3_local",
        recommendedModels: ["llama-3-8b-instruct", "mistral-7b", "ollama-local"],
        maxTokens: 2048,
        temperature: 0.1,
        cacheEnabled: false,
      };
    }
  }

  // Default to Tier 2 Resilient Execution for Code Generation and Testing
  return {
    tier: "tier_2_resilient",
    recommendedModels: ["claude-3-5-sonnet", "gpt-4o-mini", "deepseek-coder", "gemini-1-5-pro"],
    maxTokens: 4096,
    temperature: 0.2,
    cacheEnabled: true,
  };
}
