/**
 * SPB-IR Tiered Model Registry & Decision Engine
 * Maps classified task phases and complexity scores to dynamic model tiers
 * (Tier 1: Apex Reasoning, Tier 2: Resilient Execution, Tier 3: Local Edge Inference).
 */

import { TaskPhase, type GuidanceContract } from "./intentAnalyzer.ts";
import { type TierModelsConfig } from "../tierTypes.ts";

export type ModelTier = "tier_1_apex" | "tier_2_resilient" | "tier_3_local";

export interface TierAssignment {
  tier: ModelTier;
  recommendedModels: string[];
  maxTokens: number;
  temperature: number;
  cacheEnabled: boolean;
  guidanceContract?: GuidanceContract;
  requiresGuidance?: boolean;
}

export function selectModelTier(
  taskPhase: TaskPhase,
  _complexityScore: number,
  customModels?: TierModelsConfig,
  _requiresTools?: boolean,
  isToolResultTurn?: boolean,
  guidanceContract?: GuidanceContract
): TierAssignment {
  const models = {
    apex: customModels?.apex ?? [],
    resilient: customModels?.resilient ?? [],
    local: customModels?.local ?? [],
  };

  // Only block Tier 1/3 during ACTIVE tool execution (tool result turn), not when tools are merely available.
  // This allows plan mode / architectural planning (Tier 1) and refactoring (Tier 3) to route correctly
  // even when the agent runtime provides tools, as long as we're not mid-execution.
  const inToolExecution = isToolResultTurn === true;

  // 1. Tier 1: Strictly reserved for architectural planning and complex apex reasoning.
  // Tier 1 models are costly and must not handle code execution tasks, but they DO handle
  // inspection tools (Read, Grep, MCP, research) during planning.
  if (taskPhase === "ARCHITECTURAL_PLANNING") {
    return {
      tier: "tier_1_apex",
      recommendedModels: models.apex,
      maxTokens: 16384,
      temperature: 0.2,
      cacheEnabled: true,
      guidanceContract,
      requiresGuidance: false,
    };
  }

  // 2. Tier 3: Local/edge inference, inspection synthesis, refactoring, formatting, and deterministic tasks.
  // Governed Tier 3 Execution: When assigning tier_3_local, pass through guidanceContract and mark
  // requiresGuidance = true when assigned without an existing guidance contract.
  // Tier 3 is allowed for read-only INSPECTION_SYNTHESIS,
  // or for FAST_REFACTOR / DETERMINISTIC_ROUTING ONLY when not in active tool execution.
  if (
    taskPhase === "INSPECTION_SYNTHESIS" ||
    (!inToolExecution && (taskPhase === "FAST_REFACTOR" || taskPhase === "DETERMINISTIC_ROUTING"))
  ) {
    return {
      tier: "tier_3_local",
      recommendedModels: models.local,
      maxTokens: 4096,
      temperature: 0.1,
      cacheEnabled: false,
      guidanceContract,
      requiresGuidance: !guidanceContract,
    };
  }

  // 3. Tier 2: Resilient execution for code generation, testing, tool-heavy execution
  return {
    tier: "tier_2_resilient",
    recommendedModels: models.resilient,
    maxTokens: 8192,
    temperature: 0.2,
    cacheEnabled: true,
    guidanceContract,
    requiresGuidance: false,
  };
}
