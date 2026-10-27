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
  // isToolExecution is intentionally unused to maintain architectural consistency and boundary definitions

  // 1. Tier 1: Strictly reserved for architectural planning and complex apex reasoning.
  // Tier 1 models are costly and must not handle code execution tasks, but they DO handle
  // inspection tools (Read, Grep, Glob, MCP, research) during planning.
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
  // GOVERNED TIER 3 EXECUTION: All Tier 3 execution requires architectural supervision via GuidanceContract.
  // TIER 3 STRICTNESS: Must have guidanceContract from supervisor tiers (Tier 1 or Tier 2) for ALL phases,
  // including INSPECTION_SYNTHESIS when it involves code/model analysis or modifications.
  // Prevents unguided code modifications, enforcing architectural planning and validation before execution.
  // TIER 3 ALLOWANCES: ONLY permitted for truly read-only inspection without any code analysis or model evaluation.
  // INSPECTION_SYNTHESIS involving code review, model analysis, or deterministic task assessment
  // ALWAYS requires guidanceContract. isToolExecution → all tool mutations forced to Tier 2 (Resilient) for safety.
  const isInToolExecution = isToolResultTurn === true;
  const isSupervisedCodeGen =
    taskPhase === "CODE_GENERATION" &&
    !!guidanceContract &&
    (guidanceContract.origin === "supervisor" || guidanceContract.supervisorTier === "tier_1_apex");

  console.log(
    `[SPB TieredRegistry] Evaluating taskPhase: ${taskPhase}, isInToolExecution: ${isInToolExecution}, guidanceContract present: ${!!guidanceContract}, isSupervisedCodeGen: ${isSupervisedCodeGen}`
  );
  if (
    taskPhase === "INSPECTION_SYNTHESIS" ||
    (!isInToolExecution &&
      (taskPhase === "FAST_REFACTOR" ||
        taskPhase === "DETERMINISTIC_ROUTING" ||
        isSupervisedCodeGen))
  ) {
    console.log(
      `[SPB TieredRegistry] Routing taskPhase ${taskPhase} to tier_3_local (guidanceContract: ${!!guidanceContract})`
    );
    // ALL Tier 3 phases now require guidanceContract, including INSPECTION_SYNTHESIS
    // when it involves code/model analysis or deterministic task assessment.
    const effectiveRequiresGuidance = true; // Always require guidance for Tier 3
    return {
      tier: "tier_3_local",
      recommendedModels: models.local,
      maxTokens: 4096,
      temperature: 0.1,
      cacheEnabled: false,
      guidanceContract,
      requiresGuidance: effectiveRequiresGuidance,
    };
  }

  // All other Tier 3 requests (mutating without guidance, inToolExecution, or other phases) MUST escalate
  // This prevents unguided code modifications and enforces architectural supervision

  // TIER 3 ESCALATION: When Tier 3 is not allowed, force escalation to Tier 2 resilient
  // This ensures that all code modifications go through proper architectural supervision channels
  // and prevents any unguided destructive changes from reaching Tier 3

  // 3. Tier 2: Resilient execution for code generation, testing, tool-heavy execution
  // TIER 2 ROLE: Production-grade execution with robust error handling, verification, and resilience
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

/**
 * Validates guidanceContract requirements for Tier 3 execution
 * Ensures all Tier 3 mutations have proper architectural supervision
 */
export function validateTier3Execution(
  taskPhase: TaskPhase,
  _inToolExecution: boolean,
  guidanceContract: GuidanceContract | undefined,
  currentTier: ModelTier = "tier_3_local"
): { isValid: boolean; tier: ModelTier; reason?: string } {
  // TIER 3 VALIDATION: All Tier 3 execution requires guidanceContract
  if (currentTier === "tier_3_local") {
    if (guidanceContract) {
      return { isValid: true, tier: "tier_3_local" };
    }

    // TIER 3 VIOLATION: Attempting Tier 3 execution without guidanceContract is invalid
    return {
      isValid: false,
      tier: "tier_2_resilient",
      reason: `Tier 3 execution for ${taskPhase} requires GuidanceContract from supervisor tiers (Tier 1 or Tier 2) for architectural supervision. Escalating to Tier 2 resilient for proper constraint generation and validation.`,
    };
  }

  // TIER 3 ESCALATION: All other Tier 3 requests default to Tier 2 resilient execution
  return { isValid: false, tier: "tier_2_resilient" };
}
