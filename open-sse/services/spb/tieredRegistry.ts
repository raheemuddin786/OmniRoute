/**
 * SPB-IR Tiered Model Registry & Decision Engine
 * Maps classified task phases and complexity scores to dynamic model tiers
 * (Tier 1: Apex Reasoning, Tier 2: Resilient Execution, Tier 3: Local Edge Inference).
 */

import { TaskPhase } from "./intentAnalyzer.ts";
import { type TierModelsConfig } from "../tierTypes.ts";

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
  _complexityScore: number,
  customModels?: TierModelsConfig,
  requiresTools?: boolean
): TierAssignment {
  const models = {
    apex: customModels?.apex ?? [],
    resilient: customModels?.resilient ?? [],
    local: customModels?.local ?? [],
  };

  // 1. Tier 1: Strictly reserved for architectural planning and complex apex reasoning.
  // Tier 1 models are costly and must not handle execution tasks.
  if (taskPhase === "ARCHITECTURAL_PLANNING") {
    return {
      tier: "tier_1_apex",
      recommendedModels: models.apex,
      maxTokens: 16384,
      temperature: 0.2,
      cacheEnabled: true,
    };
  }

  // 2. Tier 3: Local/edge inference, refactoring, formatting, and deterministic tasks.
  // Restricted to tasks without active tool calling requirements.
  if ((taskPhase === "FAST_REFACTOR" || taskPhase === "DETERMINISTIC_ROUTING") && !requiresTools) {
    return {
      tier: "tier_3_local",
      recommendedModels: models.local,
      maxTokens: 4096,
      temperature: 0.1,
      cacheEnabled: false,
    };
  }

  // 3. Tier 2: Resilient execution, code generation, test iteration, and verification.
  // Handles all code generation, testing, tool-calling agents, and complex execution.
  return {
    tier: "tier_2_resilient",
    recommendedModels: models.resilient,
    maxTokens: 8192,
    temperature: 0.2,
    cacheEnabled: true,
  };
}
