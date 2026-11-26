/**
 * SPB-IR Tiered Model Registry & Decision Engine
 * Maps classified task phases and complexity scores to dynamic model tiers
 * (Tier 1: Apex Reasoning, Tier 2: Resilient Execution, Tier 3: Local Edge Inference).
 */

import { TaskPhase, type GuidanceContract } from "./intentAnalyzer.ts";
import { type TierModelsConfig } from "../tierTypes.ts";
import { checkCooldownStatus } from "../globalRateLimiter.ts";
import { isFreeModelTarget } from "../spbFreeTierAutoConfig.ts";
import { getTierConfig, resolveVirtualTierModels } from "../tierResolver.ts";
import { getModelPricing } from "../providerCostData.ts";

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

function getModelCost(model: string): number {
  const provider = model.includes("/") ? model.split("/")[0] : "";
  const modelId = model.includes("/") ? model.split("/").slice(1).join("/") : model;
  try {
    const pricing = getModelPricing(provider, modelId);
    if (pricing.isFree) return 0;
    return (pricing.inputCostPer1M ?? 0) + (pricing.outputCostPer1M ?? 0);
  } catch {
    return 1.0;
  }
}

/**
 * Reorders candidates to place healthy, non-cooldown models first,
 * sorting healthy models by cost (lowest cost first).
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

  // Sort healthy models by combined cost per 1M tokens (lowest first)
  healthy.sort((a, b) => getModelCost(a) - getModelCost(b));

  return healthy.length > 0 ? [...healthy, ...inCooldown] : inCooldown;
}

export function selectModelTier(
  taskPhase: TaskPhase,
  complexityScore: number,
  customModels?: TierModelsConfig,
  _requiresTools?: boolean,
  isToolResultTurn?: boolean,
  guidanceContract?: GuidanceContract,
  profileName?: string
): TierAssignment {
  const currentConfig = getTierConfig(profileName);
  const onlyFree = currentConfig?.onlyFreeTierModels === true;

  const filterIfFreeOnly = (tierList: string[], tierKey: "apex" | "resilient" | "local") => {
    // When tierMode is explicitly "user", do not filter out user-configured models
    if (currentConfig?.tierModes?.[tierKey] === "user") {
      return tierList;
    }
    const isFreeTier = onlyFree || currentConfig?.tierModes?.[tierKey] === "free";
    if (!isFreeTier) return tierList;
    return tierList.filter(isFreeModelTarget);
  };

  // If customModels for a tier is empty or not provided, resolve virtual/auto candidates for that tier
  const getEffectiveTierModels = (
    tierKey: "apex" | "resilient" | "local",
    customList?: string[]
  ) => {
    const isUserMode = currentConfig?.tierModes?.[tierKey] === "user";
    if (isUserMode) {
      // In user mode, strictly return user-configured models. Never fall back to virtual/free models.
      return customList ?? [];
    }
    const directList = filterIfFreeOnly(customList ?? [], tierKey);
    if (directList.length > 0) return directList;
    try {
      const virtual = resolveVirtualTierModels(
        `tier_${tierKey === "apex" ? "1_apex" : tierKey === "local" ? "3_local" : "2_resilient"}`
      );
      return filterIfFreeOnly(virtual, tierKey);
    } catch {
      return directList;
    }
  };

  const rawApex = getEffectiveTierModels("apex", customModels?.apex);
  const rawResilient = getEffectiveTierModels("resilient", customModels?.resilient);
  const rawLocal = getEffectiveTierModels("local", customModels?.local);

  const models = {
    apex: prioritizeHealthyTierModels(rawApex),
    resilient: prioritizeHealthyTierModels(rawResilient),
    local: prioritizeHealthyTierModels(rawLocal),
  };

  // Dynamically calibrate token bounds based on task complexity (0.0 to 1.0) and runtime config
  const normScore =
    typeof complexityScore === "number" && Number.isFinite(complexityScore)
      ? Math.max(0, Math.min(1, complexityScore))
      : 0.5;

  const spbConfig = currentConfig?.spbConfig;
  const apexBounds = spbConfig?.tokenBounds?.apex ?? { high: 16384, medium: 12288, low: 8192 };
  const resilientBounds = spbConfig?.tokenBounds?.resilient ?? {
    high: 8192,
    medium: 8192,
    low: 4096,
  };
  const localBounds = spbConfig?.tokenBounds?.local ?? { high: 4096, medium: 4096, low: 2048 };

  const apexMaxTokens =
    normScore >= 0.7 ? apexBounds.high : normScore <= 0.3 ? apexBounds.low : apexBounds.medium;
  const resilientMaxTokens =
    normScore >= 0.7
      ? resilientBounds.high
      : normScore <= 0.3
        ? resilientBounds.low
        : resilientBounds.medium;
  const localMaxTokens =
    normScore >= 0.7 ? localBounds.high : normScore <= 0.3 ? localBounds.low : localBounds.medium;

  const apexProfile = spbConfig?.tierProfiles?.apex ?? {
    temperature: 0.2,
    reasoningEffort: "high" as const,
  };
  const resilientProfile = spbConfig?.tierProfiles?.resilient ?? {
    temperature: 0.2,
    reasoningEffort: "medium" as const,
  };
  const localProfile = spbConfig?.tierProfiles?.local ?? {
    temperature: 0.1,
    reasoningEffort: "low" as const,
  };

  // 1. Tier 1: Strictly reserved for architectural planning and complex apex reasoning.
  if (taskPhase === "ARCHITECTURAL_PLANNING") {
    return {
      tier: "tier_1_apex",
      recommendedModels: models.apex,
      maxTokens: apexMaxTokens,
      temperature: apexProfile.temperature,
      cacheEnabled: true,
      reasoningEffort: apexProfile.reasoningEffort,
      guidanceContract,
      requiresGuidance: false,
    };
  }

  // 1b. Image Generation / Multimodal Creation: Route to apex/resilient models capable of high-fidelity visual tasks
  if (taskPhase === "IMAGE_GENERATION") {
    const visionCapableCandidates = [
      ...models.apex.filter((m) =>
        /vision|image|dall-e|flux|midjourney|ideogram|gemini|gpt-4o|claude/i.test(m)
      ),
      ...models.resilient.filter((m) =>
        /vision|image|dall-e|flux|midjourney|ideogram|gemini|gpt-4o|claude/i.test(m)
      ),
    ];
    const imageModels = visionCapableCandidates.length > 0 ? visionCapableCandidates : models.apex;
    return {
      tier: "tier_1_apex",
      recommendedModels: imageModels,
      maxTokens: apexMaxTokens,
      temperature: 0.7, // Higher creative fidelity for image generation prompts
      cacheEnabled: false,
      reasoningEffort: "medium",
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

  // INSPECTION_SYNTHESIS tool result turns are read-only inspection (grep, search, read)
  // and should route to Tier 3 Local per the intent classification hierarchy.
  // Only CODE_GENERATION tool results (active code mutation) should stay in Tier 2.
  const isInspectionToolResult = isToolResultTurn && taskPhase === "INSPECTION_SYNTHESIS";

  console.log(
    `[SPB TieredRegistry] Evaluating taskPhase: ${taskPhase}, isInToolExecution: ${isInToolExecution}, isInspectionToolResult: ${isInspectionToolResult}, guidanceContract present: ${!!guidanceContract}, isSupervisedCodeGen: ${isSupervisedCodeGen}`
  );
  // Keep active code mutation tool execution turns in resilient tier to prevent oscillation
  // Allow read-only inspection tool results (INSPECTION_SYNTHESIS) to route to Tier 3
  if (
    (!isInToolExecution || isInspectionToolResult) &&
    (taskPhase === "INSPECTION_SYNTHESIS" ||
      taskPhase === "FAST_REFACTOR" ||
      taskPhase === "DETERMINISTIC_ROUTING" ||
      isSupervisedCodeGen)
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
      temperature: localProfile.temperature,
      cacheEnabled: false,
      reasoningEffort: localProfile.reasoningEffort,
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
    temperature: resilientProfile.temperature,
    cacheEnabled: true,
    reasoningEffort: resilientProfile.reasoningEffort,
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

export interface ToolFailureRecoveryResult {
  isDeadlocked: boolean;
  correctiveDirective?: string;
  newTaskPhase?: TaskPhase;
  escalationTier?: "tier_1_apex" | "tier_2_resilient" | "tier_3_local";
  updatedConsecutiveFailures: number;
}

/**
 * Detects repeated tool failures and generates actionable, prescriptive guidance
 * to unblock agents stuck in repetitive error loops (e.g. failing edits).
 */
export function detectAndRecoverFromToolDeadlock(
  toolFailureDiagnostic:
    | {
        toolName?: string;
        filePath?: string;
        errorReason: string;
        rawErrorSnippet: string;
      }
    | undefined,
  consecutiveToolFailures: number,
  _taskPhase: TaskPhase,
  customThreshold?: number
): ToolFailureRecoveryResult {
  const threshold = customThreshold ?? getTierConfig()?.spbConfig?.toolFailureThreshold ?? 2;

  if (!toolFailureDiagnostic) {
    return {
      isDeadlocked: false,
      updatedConsecutiveFailures: 0,
    };
  }

  const newConsecutiveFailures = consecutiveToolFailures + 1;
  if (newConsecutiveFailures < threshold) {
    return {
      isDeadlocked: false,
      updatedConsecutiveFailures: newConsecutiveFailures,
    };
  }

  const toolName = toolFailureDiagnostic.toolName || "the tool";
  const file = toolFailureDiagnostic.filePath ? ` on ${toolFailureDiagnostic.filePath}` : "";
  let specificAdvice = "";

  switch (toolFailureDiagnostic.errorReason) {
    case "string_not_found":
      specificAdvice =
        "The string you specified as target/old_string does NOT match the file content exactly.\n" +
        "ACTION REQUIRED:\n" +
        "1. Do NOT retry the same edit with the same old_string.\n" +
        "2. Call Read/View on the exact line range first to inspect the current formatting, indentation, and characters.\n" +
        "3. Use a shorter, unique anchor snippet instead of multi-line blocks that can mismatch whitespace.\n" +
        "4. If surgical editing continues to fail, use the Write tool or bash sed/awk/node script to overwrite or rewrite cleanly.";
      break;

    case "multiple_matches":
      specificAdvice =
        "The string to replace appears multiple times in the file, causing ambiguity.\n" +
        "ACTION REQUIRED:\n" +
        "1. Expand the old_string target to include surrounding unique context lines (before and after).\n" +
        "2. If replacing every occurrence across the file was your intent, set replace_all: true.";
      break;

    case "no_changes":
      specificAdvice =
        "The new_string is identical to old_string; no modification occurred.\n" +
        "ACTION REQUIRED: Verify the changes you intended to make. Ensure new_string contains the actual fix.";
      break;

    case "file_modified_since_read":
      specificAdvice =
        "The file was modified on disk since your last read (e.g., by another tool or formatter).\n" +
        "ACTION REQUIRED: Re-read the file immediately before executing your next edit.";
      break;

    case "tool_not_available":
      specificAdvice =
        `The tool "${toolName}" is not available in this environment.\n` +
        "ACTION REQUIRED: Use standard shell commands via Bash (e.g., grep, find, sed) or installed workspace tools instead of calling unavailable tools.";
      break;

    case "json_parse_error":
      specificAdvice =
        "The tool argument payload was rejected because of invalid JSON formatting or unescaped characters.\n" +
        "ACTION REQUIRED: Ensure tool arguments are clean, valid JSON without unescaped newlines or quotes.";
      break;

    default:
      specificAdvice =
        `Repeated failures (${newConsecutiveFailures} attempts) encountered executing ${toolName}${file}.\n` +
        "ACTION REQUIRED:\n" +
        "1. Stop repeating the same failing action.\n" +
        "2. Switch strategies: inspect the target state, consider an alternative tool, or use Bash commands directly.";
      break;
  }

  const correctiveDirective =
    `[SPB Autonomous Execution Alert: REPEATED TOOL FAILURE DEADLOCK DETECTED (${newConsecutiveFailures} attempts)]\n` +
    `Your calls to ${toolName}${file} have repeatedly failed with: "${toolFailureDiagnostic.rawErrorSnippet.slice(0, 150)}"\n\n` +
    specificAdvice;

  return {
    isDeadlocked: true,
    correctiveDirective,
    newTaskPhase: "CODE_GENERATION",
    escalationTier: "tier_2_resilient",
    updatedConsecutiveFailures: newConsecutiveFailures,
  };
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
    lastMutationTime?: number;
    lastPeriodicPromptTime?: number;
    stagnationRecovered?: boolean;
  },
  options?: {
    elapsedSinceLastMutationMs?: number;
  }
): {
  isStagnant: boolean;
  recoveryDirective?: string;
  newTaskPhase?: TaskPhase;
  escalationTier?: "tier_1_apex" | "tier_2_resilient" | "tier_3_local";
  updatedCheckpoint?: {
    consecutiveReads?: number;
    modelTier?: string;
    guidanceContract?: GuidanceContract;
    lastMutationTime?: number;
    lastPeriodicPromptTime?: number;
    stagnationRecovered?: boolean;
  };
} {
  const currentConfig = getTierConfig();
  const stagnationThreshold = currentConfig?.spbConfig?.stagnationThreshold ?? 5;
  const stagnationIntervalMs =
    Number(process.env.OMNIROUTE_SPB_STAGNATION_INTERVAL_MS) > 0
      ? Number(process.env.OMNIROUTE_SPB_STAGNATION_INTERVAL_MS)
      : (currentConfig?.spbConfig?.stagnationIntervalMs ?? 120_000); // 2 minutes default
  const enableSelfCorrectionPrompt =
    process.env.OMNIROUTE_SPB_ENABLE_SELF_CORRECTION !== undefined
      ? process.env.OMNIROUTE_SPB_ENABLE_SELF_CORRECTION === "true"
      : (currentConfig?.spbConfig?.enableSelfCorrectionPrompt ?? true);

  let isStagnant = false;
  let recoveryDirective: string | undefined;
  let newTaskPhase: TaskPhase | undefined;
  let escalationTier: "tier_1_apex" | "tier_2_resilient" | "tier_3_local" | undefined;

  const now = Date.now();
  const elapsedSinceLastMutation = options?.elapsedSinceLastMutationMs ?? 0;
  const lastPeriodicPrompt = existingCheckpoint?.lastPeriodicPromptTime ?? 0;
  const timeSinceLastPrompt = now - lastPeriodicPrompt;

  // Check 1: Periodic 2-Minute Stagnation / Self-Correction Alert
  // If agent has had no verified code mutation for >= 2 minutes (120s) and at least 2 minutes have elapsed since the last alert
  const isTimeStalled =
    enableSelfCorrectionPrompt &&
    elapsedSinceLastMutation >= stagnationIntervalMs &&
    timeSinceLastPrompt >= stagnationIntervalMs;

  if (isTimeStalled) {
    isStagnant = true;
    const elapsedMinutes = Math.round(elapsedSinceLastMutation / 60000);
    recoveryDirective =
      `[SPB Autonomous Self-Correction Alert: STALL / LOOP DETECTED (~${elapsedMinutes}m elapsed without code progress)]\n` +
      `You have been executing tools on this task for over ${elapsedMinutes} minute(s) without verified code modifications.\n` +
      `Perform an immediate self-audit before invoking another tool:\n` +
      `1. Hallucination check: Are you looking for files, symbols, endpoints, or error signatures that do NOT exist in this repo?\n` +
      `2. Divergence check: Have you drifted away from the primary user objective?\n` +
      `3. Token waste check: Are you running redundant reads/searches or repeating failing commands without new insights?\n` +
      `If you have gathered sufficient context, construct a COMPLETE pre-plan: enumerate every file requiring changes, all type contracts, imports, and test surfaces. Then execute the full solution cleanly end-to-end without trial-and-error. Do NOT make blind micro-edits before planning.`;

    const testPattern = /\b(test|spec|verify|assert|coverage)\b/i;
    newTaskPhase = testPattern.test(taskPhase) ? "TESTING_AND_VERIFICATION" : "CODE_GENERATION";
    escalationTier = "tier_2_resilient";

    return {
      isStagnant: true,
      recoveryDirective,
      newTaskPhase,
      escalationTier,
      updatedCheckpoint: {
        ...existingCheckpoint,
        consecutiveReads: 0,
        lastPeriodicPromptTime: now,
        stagnationRecovered: true,
      },
    };
  }

  // If previous turn already applied recovery, don't re-detect immediately on read turns.
  // Require consecutiveReads to re-accumulate to at least stagnationThreshold before re-triggering.
  if (existingCheckpoint?.stagnationRecovered && consecutiveReads < stagnationThreshold) {
    return {
      isStagnant: false,
      escalationTier: undefined,
      updatedCheckpoint: {
        ...existingCheckpoint,
        consecutiveReads,
        stagnationRecovered: false, // Clear flag so future reads properly trigger detection
      },
    };
  }

  // Detect stagnation based on cumulative non-mutating turns.
  if (consecutiveReads >= stagnationThreshold) {
    isStagnant = true;

    // Softened recovery guidance (Operator requirement 4)
    if (taskPhase === "ARCHITECTURAL_PLANNING") {
      recoveryDirective =
        "[Auto-Recovery Directive: SDLC PLANNING GUIDANCE]\n" +
        "Context acquisition complete. Formulate a structured, end-to-end SDLC plan with an explicit, trackable checklist covering: " +
        "requirements -> architecture -> implementation targets -> automated test suites -> verification criteria. " +
        "Do not emit blind file modification commands without a validated implementation strategy.";
      newTaskPhase = "ARCHITECTURAL_PLANNING";
      escalationTier = "tier_1_apex";
    } else {
      recoveryDirective =
        "[Auto-Recovery Directive: PRE-PLAN & UNIFIED EXECUTION]\n" +
        "Context checkpoint reached. Before writing any code: formulate the complete multi-file implementation plan listing all impacted files, type contracts, imports, and verification steps. " +
        "Then apply all changes cleanly end-to-end in a single planned execution. Never make trial-and-error micro-edits.";
      const testPattern = /\b(test|spec|verify|assert|coverage)\b/i;
      newTaskPhase = testPattern.test(taskPhase) ? "TESTING_AND_VERIFICATION" : "CODE_GENERATION";

      // Escalate tier assignment:
      const currentTier = existingCheckpoint?.modelTier || "tier_2_resilient";
      if (currentTier === "tier_2_resilient" && consecutiveReads > 5) {
        escalationTier = "tier_1_apex";
        newTaskPhase = "ARCHITECTURAL_PLANNING";
        recoveryDirective =
          "[Auto-Recovery Directive: APEX REASONING ESCALATION]\n" +
          "Repeated non-mutating tool cycles detected on execution tier. Re-evaluating strategy with architectural guidance. " +
          "Synthesize gathered context and formulate a direct file-modification action plan.";
      } else if (currentTier === "tier_3_local") {
        escalationTier = "tier_2_resilient";
      } else {
        escalationTier = "tier_2_resilient";
      }
    }

    if (existingCheckpoint) {
      existingCheckpoint = {
        ...existingCheckpoint,
        consecutiveReads: 0,
        lastPeriodicPromptTime: now,
        stagnationRecovered: true,
      };
    }
  }

  return {
    isStagnant,
    recoveryDirective,
    newTaskPhase,
    escalationTier,
    updatedCheckpoint: existingCheckpoint,
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
    "Before making any edits, formulate a complete multi-file plan covering all files to be changed, the order of changes, and expected outcomes. Only begin editing after the plan is fully formed.";

  // escalate to CODE_GENERATION or TESTING_AND_VERIFICATION based on content
  const testPattern = /\b(test|spec|verify|assert|coverage)\b/i;
  const newTaskPhase = testPattern.test(taskPhase) ? "TESTING_AND_VERIFICATION" : "CODE_GENERATION";

  // Preserve consecutiveReads in checkpoint — do not reset until genuine code mutation
  if (existingCheckpoint) {
    existingCheckpoint = {
      ...existingCheckpoint,
      consecutiveReads,
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
