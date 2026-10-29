/**
 * SPB-IR Tiered Model Registry & Decision Engine
 * Maps classified task phases and complexity scores to dynamic model tiers
 * (Tier 1: Apex Reasoning, Tier 2: Resilient Execution, Tier 3: Local Edge Inference).
 */

import { TaskPhase, type GuidanceContract } from "./intentAnalyzer.ts";
import { type TierModelsConfig } from "../tierTypes.ts";
import { checkCooldownStatus } from "../globalRateLimiter.ts";

export type ModelTier = "tier_1_apex" | "tier_2_resilient" | "tier_3_local";

export interface TierAssignment {
  tier: ModelTier;
  recommendedModels: string[];
  maxTokens: number;
  temperature: number;
  cacheEnabled: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  guidanceContract?: GuidanceContract;
  requiresGuidance?: boolean;
}

/**
 * Reorders candidates to place healthy, non-cooldown models first
 */
function prioritizeHealthyTierModels(models: string[]): string[] {
  if (!models || models.length <= 1) return models || [];
  const healthy: string[] = [];
  const inCooldown: string[] = [];

  for (const model of models) {
    const provider = model.includes("/") ? model.split("/")[0] : "";
    const modelId = model.includes("/") ? model.split("/").slice(1).join("/") : model;
    try {
      const status = checkCooldownStatus(provider, null, modelId);
      if (status.allowed) {
        healthy.push(model);
      } else {
        inCooldown.push(model);
      }
    } catch {
      healthy.push(model);
    }
  }

  return healthy.length > 0 ? [...healthy, ...inCooldown] : inCooldown;
}

export function selectModelTier(
  taskPhase: TaskPhase,
  complexityScore: number,
  customModels?: TierModelsConfig,
  _requiresTools?: boolean,
  isToolResultTurn?: boolean,
  guidanceContract?: GuidanceContract
): TierAssignment {
  const models = {
    apex: prioritizeHealthyTierModels(customModels?.apex ?? []),
    resilient: prioritizeHealthyTierModels(customModels?.resilient ?? []),
    local: prioritizeHealthyTierModels(customModels?.local ?? []),
  };

  // Dynamically calibrate token bounds based on task complexity (0.0 to 1.0)
  const normScore =
    typeof complexityScore === "number" && Number.isFinite(complexityScore)
      ? Math.max(0, Math.min(1, complexityScore))
      : 0.5;

  const apexMaxTokens = normScore >= 0.7 ? 16384 : normScore <= 0.3 ? 8192 : 12288;
  const resilientMaxTokens = normScore >= 0.7 ? 8192 : normScore <= 0.3 ? 4096 : 8192;
  const localMaxTokens = normScore >= 0.7 ? 4096 : normScore <= 0.3 ? 2048 : 4096;

  // 1. Tier 1: Strictly reserved for architectural planning and complex apex reasoning.
  if (taskPhase === "ARCHITECTURAL_PLANNING") {
    return {
      tier: "tier_1_apex",
      recommendedModels: models.apex,
      maxTokens: apexMaxTokens,
      temperature: 0.2,
      cacheEnabled: true,
      reasoningEffort: "high",
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
  // This ensures that each tier's execution environment meets strict safety and architectural validation criteria.
  // TIER 3 SELECTION: Any Tier 3 execution must have an active guidanceContract to enforce supervision and prevent unguided actions.
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
      maxTokens: localMaxTokens,
      temperature: 0.1,
      cacheEnabled: false,
      reasoningEffort: "low",
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
    maxTokens: resilientMaxTokens,
    temperature: 0.2,
    cacheEnabled: true,
    reasoningEffort: "medium",
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

/**
 * Enhanced stagnation detection with comprehensive recovery mechanism
 */
export function detectAndRecoverFromStagnation(
  _sessionId: string,
  taskPhase: TaskPhase,
  consecutiveReads: number,
  existingCheckpoint?: {
    consecutiveReads?: number;
    modelTier?: string;
    guidanceContract?: GuidanceContract;
  }
): {
  isStagnant: boolean;
  recoveryDirective?: string;
  newTaskPhase?: TaskPhase;
  escalationTier?: "tier_1_apex" | "tier_2_resilient" | "tier_3_local";
} {
  const STAGNATION_THRESHOLD = 3;
  let isStagnant = false;
  let recoveryDirective: string | undefined;
  let newTaskPhase: TaskPhase | undefined;
  let escalationTier: "tier_1_apex" | "tier_2_resilient" | "tier_3_local" | undefined;

  // Detect stagnation based on consecutive read/inspection turns
  if (consecutiveReads >= STAGNATION_THRESHOLD && taskPhase === "INSPECTION_SYNTHESIS") {
    isStagnant = true;

    // Generate recovery directive to break the loop
    recoveryDirective =
      "EXECUTION MANDATE: You have completed sufficient inspection. Stop further read/grep/glob file inspections.";
    const testPattern = /\b(test|spec|verify|assert|coverage)\b/i;
    newTaskPhase = testPattern.test(taskPhase) ? "TESTING_AND_VERIFICATION" : "CODE_GENERATION";

    // Escalate tier assignment to tier_2_resilient to enable tool execution
    // (Tier 2 has full tool execution authority vs Tier 1 oversight or Tier 3 constraints)
    escalationTier = "tier_2_resilient";

    // Update the checkpoint with the reset counter to prevent immediate re-triggering
    if (existingCheckpoint) {
      existingCheckpoint = {
        ...existingCheckpoint,
        consecutiveReads: 0,
      };
    }
  }

  return {
    isStagnant,
    recoveryDirective,
    newTaskPhase,
    escalationTier,
  };
}

/**
 * Enhanced stagnation recovery mechanism
 * Provides immediate recovery from repetitive inspection loops
 * with structured escalation to tier_2_resilient execution
 */
export function escalateFromStagnation(
  sessionId: string,
  taskPhase: TaskPhase,
  _priorStagnationDetected: boolean,
  consecutiveReads: number,
  existingCheckpoint?: {
    consecutiveReads?: number;
    modelTier?: string;
    guidanceContract?: GuidanceContract;
  }
): { newTaskPhase: TaskPhase; escalationTier: "tier_2_resilient"; recoveryDirective: string } {
  // Determine target phase based on original user intent signals
  const recoveryDirective =
    "EXECUTION MANDATE: You have completed sufficient inspection. Stop further read/grep/glob file inspections.";

  // escalate to CODE_GENERATION or TESTING_AND_VERIFICATION based on content
  const testPattern = /\b(test|spec|verify|assert|coverage)\b/i;
  const newTaskPhase = testPattern.test(taskPhase) ? "TESTING_AND_VERIFICATION" : "CODE_GENERATION";

  // Update the checkpoint with the reset counter to prevent immediate re-triggering
  if (existingCheckpoint) {
    existingCheckpoint = {
      ...existingCheckpoint,
      consecutiveReads: 0,
    };
  }

  // Record the recovery action
  console.log(
    `[SPB Bridge] Session ${sessionId} | Stagnation recovery engaged: ${taskPhase} → ${newTaskPhase} (${consecutiveReads} reads)`
  );

  return {
    newTaskPhase,
    escalationTier: "tier_2_resilient",
    recoveryDirective,
  };
}
