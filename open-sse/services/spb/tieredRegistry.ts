/**
 * SPB-IR Tiered Model Registry & Decision Engine
 * Maps classified task phases and complexity scores to dynamic model tiers
 * (Tier 1: Apex Reasoning, Tier 2: Resilient Execution, Tier 3: Local Edge Inference).
 */

import { TaskPhase } from "./intentAnalyzer.ts";
import { type TierModelsConfig, DEFAULT_SPB_TIER_MODELS } from "../tierTypes.ts";

export type ModelTier = "tier_1_apex" | "tier_2_resilient" | "tier_3_local";

export interface TierAssignment {
  tier: ModelTier;
  recommendedModels: string[];
  maxTokens: number;
  temperature: number;
  cacheEnabled: boolean;
}

export function selectModelTier(
  taskPhase: TaskPhase,
  complexityScore: number,
  customModels?: TierModelsConfig
): TierAssignment {
  const models = {
    apex: customModels?.apex?.length ? customModels.apex : DEFAULT_SPB_TIER_MODELS.apex,
    resilient: customModels?.resilient?.length
      ? customModels.resilient
      : DEFAULT_SPB_TIER_MODELS.resilient,
    local: customModels?.local?.length ? customModels.local : DEFAULT_SPB_TIER_MODELS.local,
  };

  if (taskPhase === "ARCHITECTURAL_PLANNING" || complexityScore >= 0.85) {
    return {
      tier: "tier_1_apex",
      recommendedModels: models.apex,
      maxTokens: 8192,
      temperature: 0.2,
      cacheEnabled: true,
    };
  }

  if (taskPhase === "FAST_REFACTOR" || taskPhase === "DETERMINISTIC_ROUTING") {
    if (complexityScore < 0.3) {
      return {
        tier: "tier_3_local",
        recommendedModels: models.local,
        maxTokens: 2048,
        temperature: 0.1,
        cacheEnabled: false,
      };
    }
  }

  // Default to Tier 2 Resilient Execution for Code Generation and Testing
  return {
    tier: "tier_2_resilient",
    recommendedModels: models.resilient,
    maxTokens: 4096,
    temperature: 0.2,
    cacheEnabled: true,
  };
}
