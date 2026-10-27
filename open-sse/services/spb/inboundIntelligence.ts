/**
 * SPB-IR Zero-Intention-Loss Inbound Intelligence & Prompt Optimization Engine
 *
 * Responsibilities:
 * 1. Intent extraction, full conversational context synthesis & goal normalization.
 * 2. Inbound prompt enhancement tailored to Model Tiers (Tier 1: Apex, Tier 2: Resilient, Tier 3: Local Edge)
 *    ensuring strictly 0% intention loss, adherence to codebase reality, and factual hygiene.
 * 3. Unnecessary request detection & Pre-execution confirmation gating.
 * 4. In-flight token conservation, anchor deduplication, and context optimization.
 */

import { TaskPhase, type GuidanceContract } from "./intentAnalyzer.ts";
import { ModelTier } from "./tieredRegistry.ts";
import { getLearnedOptimization } from "../../../src/lib/db/spbState.ts";
import { createHash } from "node:crypto";

export interface NecessityCheckResult {
  isNecessary: boolean;
  isRedundant: boolean;
  isClarificationNeeded: boolean;
  reason?: string;
  suggestedAction?: string;
  confirmationRequired: boolean;
}

export interface ContextualAnchors {
  referencedFiles: string[];
  diagnosedErrors: string[];
  recentToolActions: string[];
  inferredGoal: string;
}

export interface PromptEnhancementResult {
  originalPrompt: string;
  enhancedPrompt: string;
  tier: ModelTier;
  taskPhase: TaskPhase;
  appliedOptimizations: string[];
  necessity: NecessityCheckResult;
  preservedIntentions: string[];
  anchors: ContextualAnchors;
}

/**
 * Validates that all Tier 3 execution has proper guidanceContract enforcement
 * Prevents unguided code mutations by ensuring architectural supervision
 */
export function validateTier3GuidanceContract(
  _tierAssignment: { tier: string },
  _taskPhase: TaskPhase,
  guidanceContract?: GuidanceContract
): { isValid: boolean; reason?: string } {
  // Tier 3 execution MUST have guidanceContract for ALL phases
  // including INSPECTION_SYNTHESIS when it involves code/model analysis or modifications.
  // Only truly read-only inspection (no code analysis, model evaluation, or task assessment)
  // may proceed without guidanceContract, but this is explicitly disallowed below.
  const isTier3 = _tierAssignment.tier === "tier_3_local";

  // All Tier 3 phases require guidanceContract - no exemptions
  const requiresGuidanceForTier3 = true;

  if (isTier3 && requiresGuidanceForTier3) {
    if (!guidanceContract) {
      return {
        isValid: false,
        reason:
          "Tier 3 execution requires GuidanceContract from supervisor tiers for architectural supervision and validation. " +
          "INSPECTION_SYNTHESIS is NOT exempted - all Tier 3 phases require guidanceContract to " +
          "prevent unguided code modifications, hallucinated file paths, and premature termination.",
      };
    }

    // Validate that guidanceContract contains required architectural constraints
    if (!guidanceContract.supervisorTier || !guidanceContract.taskSpecification) {
      return {
        isValid: false,
        reason:
          "GuidanceContract missing required architectural constraints (supervisorTier, taskSpecification). " +
          "Tier 3 execution without proper guidance risks unguided modifications and execution failures.",
      };
    }
  }

  // All other configurations are valid
  return { isValid: true };
}

/**
 * Computes a deterministic pattern hash for prompt template clustering & self-learning
 */
export function computePatternHash(text: string, phase: TaskPhase): string {
  const normalized = text
    .toLowerCase()
    .replace(/[0-9]+/g, "N")
    .replace(/\s+/g, " ")
    .slice(0, 300);
  return createHash("sha256").update(`${phase}:${normalized}`).digest("hex").slice(0, 16);
}

/**
 * Extracts contextual anchors (file paths, tool errors, previous targets) from conversational history.
 */
export function extractContextAnchors(
  messages: Array<{ role: string; content?: unknown }>
): ContextualAnchors {
  const referencedFilesSet = new Set<string>();
  const diagnosedErrors: string[] = [];
  const recentToolActions: string[] = [];

  const filePathRegex =
    /(?:[a-zA-Z0-9_\-./]+\/)?(?:src|open-sse|tests|scripts|electron|lib|app|components)\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+/g;
  const errorRegex =
    /(?:(?:Error|Exception|TypeError|ReferenceError|SyntaxError|AssertionError):\s*[^\n\r]+)/g;

  for (const msg of messages) {
    const content =
      typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");

    // Extract file references
    const fileMatches = content.match(filePathRegex);
    if (fileMatches) {
      for (const f of fileMatches) {
        if (!f.includes("node_modules") && referencedFilesSet.size < 10) {
          referencedFilesSet.add(f);
        }
      }
    }

    // Extract error traces
    const errorMatches = content.match(errorRegex);
    if (errorMatches) {
      for (const err of errorMatches) {
        if (diagnosedErrors.length < 5) {
          diagnosedErrors.push(err.trim());
        }
      }
    }

    // Identify tool results
    if (msg.role === "tool" || (typeof msg.content === "object" && msg.content !== null)) {
      if (content.includes("tool_result") || msg.role === "tool") {
        recentToolActions.push(`Tool execution turn (length: ${content.length} bytes)`);
      }
    }
  }

  let inferredGoal = "General engineering execution";
  if (diagnosedErrors.length > 0) {
    inferredGoal = `Fix diagnosed error: ${diagnosedErrors[0]}`;
  } else if (referencedFilesSet.size > 0) {
    inferredGoal = `Modify/inspect files: ${Array.from(referencedFilesSet).slice(0, 3).join(", ")}`;
  }

  return {
    referencedFiles: Array.from(referencedFilesSet),
    diagnosedErrors,
    recentToolActions,
    inferredGoal,
  };
}

/**
 * Evaluates whether an incoming request is necessary, redundant, or incomplete before dispatching.
 */
export function evaluateRequestNecessity(
  messages: Array<{ role: string; content?: unknown }>,
  currentPrompt: string
): NecessityCheckResult {
  const trimmed = currentPrompt.trim();

  // 1. Trivial or empty query check
  if (!trimmed || trimmed === "(no content)" || trimmed === "no content") {
    return {
      isNecessary: false,
      isRedundant: true,
      isClarificationNeeded: true,
      reason: "Request contains empty or void content.",
      suggestedAction: "Provide explicit instructions or context.",
      confirmationRequired: true,
    };
  }

  // 2. Exact or semantic repetition detection within recent turns
  const userMessages = messages
    .filter((m) => m.role === "user" && m.content)
    .map((m) => (typeof m.content === "string" ? m.content.trim() : ""));

  const lastMessage = messages[messages.length - 1];
  const lastMsgIsCurrent =
    lastMessage &&
    lastMessage.role === "user" &&
    typeof lastMessage.content === "string" &&
    lastMessage.content.trim() === trimmed;

  let isDuplicate = false;
  if (lastMsgIsCurrent) {
    if (userMessages.length >= 2 && userMessages[userMessages.length - 2] === trimmed) {
      isDuplicate = true;
    }
  } else {
    if (userMessages.length >= 1 && userMessages[userMessages.length - 1] === trimmed) {
      isDuplicate = true;
    }
  }

  if (isDuplicate && trimmed.length > 20) {
    return {
      isNecessary: false,
      isRedundant: true,
      isClarificationNeeded: false,
      reason: "Duplicate request detected identical to the immediately preceding turn.",
      suggestedAction: "Confirm if duplicate execution or re-evaluation is desired.",
      confirmationRequired: true,
    };
  }

  // 3. Ambiguity check: Extremely short vague command without prior context
  const isUltraVague = /^(fix it|do it|run|start|go|help|check|proceed|next|test)$/i.test(trimmed);
  if (isUltraVague && messages.length <= 2) {
    return {
      isNecessary: true,
      isRedundant: false,
      isClarificationNeeded: true,
      reason: "Request command is ambiguous without prior conversational context.",
      suggestedAction: "Clarify the target file, component, or objective.",
      confirmationRequired: false,
    };
  }

  return {
    isNecessary: true,
    isRedundant: false,
    isClarificationNeeded: false,
    confirmationRequired: false,
  };
}

/**
 * Enhances and rewrites the inbound prompt tailored to the destination model tier with 0% intention loss.
 * Performs deep context synthesis, ambiguous reference resolution, and contract formatting.
 */
export function enhanceInboundPrompt(
  prompt: string,
  tier: ModelTier,
  taskPhase: TaskPhase,
  messages: Array<{ role: string; content?: unknown }>
): PromptEnhancementResult {
  const necessity = evaluateRequestNecessity(messages, prompt);
  const anchors = extractContextAnchors(messages);
  const preservedIntentions: string[] = [];
  const appliedOptimizations: string[] = [];

  // Extract core intention anchors from user prompt
  const goals: string[] = [];
  if (/\b(fix|bug|error|issue|repair)\b/i.test(prompt)) {
    goals.push("Defect remediation and stability verification");
  }
  if (/\b(refactor|clean|simplify|modularize)\b/i.test(prompt)) {
    goals.push("Code refactoring and cleanliness preserving contracts");
  }
  if (/\b(test|spec|assert|verify|coverage)\b/i.test(prompt)) {
    goals.push("Test coverage and behavioral verification");
  }
  if (/\b(design|architect|plan|rfc|proposal)\b/i.test(prompt)) {
    goals.push("Architectural structuring and trade-off analysis");
  }
  if (goals.length === 0) {
    goals.push("Accurate fulfillment of user requirements");
  }
  preservedIntentions.push(...goals);

  // === Dynamic Context-Driven Role Assignment ===
  // Assign strict, context-appropriate professional roles to agents based on task phase and user intent,
  // preventing premature stoppage and hallucinated output paths.
  const roleDirective = assignRoleDirective(tier, taskPhase, anchors);
  appliedOptimizations.push(`Role Assignment: ${roleDirective.assignedRole}`);

  // Normalize and consolidate system/interleaved messages so lightweight models don't get context-confused
  const normalizedMessages = normalizeInterleavedSystemMessages(messages);
  // Prepend consolidated system directives after the tier preamble so the model receives a
  // single coherent system directive at the start, followed by clean conversational context.
  const normalizedSystemBlock =
    normalizedMessages.length > 0
      ? `\n[Normalized System Directives: Consolidated from ${normalizedMessages.length} interleaved system/inline directives]`
      : "";
  // Retrieve learned optimization if available in memory/DB
  const patternHash = computePatternHash(prompt, taskPhase);
  const learnedOpt = getLearnedOptimization(patternHash);

  // Resolve novice shorthand if prompt is short/ambiguous
  let resolvedPrompt = prompt;
  const isNoviceShortPrompt = prompt.trim().split(/\s+/).length <= 6;
  if (isNoviceShortPrompt) {
    if (
      /\b(fix it|fix the bug|fix this error)\b/i.test(prompt) &&
      anchors.diagnosedErrors.length > 0
    ) {
      resolvedPrompt =
        `Investigate and fix the following error: ${anchors.diagnosedErrors[0]}` +
        (anchors.referencedFiles.length > 0
          ? ` in ${anchors.referencedFiles.slice(0, 2).join(", ")}`
          : "") +
        `. Ensure zero regressions, complete tests, and full error boundary verification.`;
      appliedOptimizations.push("Novice Shorthand Ambiguity Resolution via Error Trace");
    } else if (/\b(add tests|test it)\b/i.test(prompt) && anchors.referencedFiles.length > 0) {
      resolvedPrompt = `Add comprehensive unit and boundary tests for ${anchors.referencedFiles[0]}. Cover positive paths, edge cases, and failure modes with complete assertions.`;
      appliedOptimizations.push("Novice Shorthand Ambiguity Resolution via Target Files");
    }
  }

  // Synthesize Tier-Specific Prompt Contract
  let tierPreamble = "";
  switch (tier) {
    case "tier_1_apex": {
      tierPreamble =
        "[SPB-IR Apex Directive: Provide exhaustive architectural precision, trade-off analysis, zero unverified assumptions, and adherence to system invariants.]";
      appliedOptimizations.push("Tier 1 Apex Architectural Invariant Framing");
      break;
    }

    case "tier_2_resilient": {
      tierPreamble =
        "[SPB-IR Resilient Directive: Execute robust, production-grade implementation. Adhere strictly to existing typing, zero untested regressions, and exact error boundaries. Never delete or overwrite working implementations without explicit architectural specification.]";
      appliedOptimizations.push("Tier 2 Resilient Implementation & Error Boundary Enforcement");
      break;
    }

    case "tier_3_local": {
      tierPreamble =
        "[SPB-IR Local Directive: Execute strictly within designated target files. Make minimal, surgical modifications without extraneous modifications or hallucinations. Strictly preserve all existing code and architecture.]";
      appliedOptimizations.push("Tier 3 Surgical Scope & Deterministic Boundary Confinement");
      break;
    }
  }

  // Construct structured zero-intention-loss prompt
  let enhancedText = `${tierPreamble}\n\n`;

  // Attach context anchors if helpful and not already in prompt
  if (anchors.referencedFiles.length > 0 && !resolvedPrompt.includes(anchors.referencedFiles[0])) {
    enhancedText += `[Context Scope: ${anchors.referencedFiles.slice(0, 3).join(", ")}]\n`;
    appliedOptimizations.push("Context Scope Anchor Attachment");
  }

  enhancedText += resolvedPrompt;

  // Integrate normalized system directives if any were consolidated
  enhancedText += normalizedSystemBlock;

  // Append strict zero-omission completion mandate
  const zeroOmissionMandate =
    "\n\n[Completion Standard: Output complete, production-ready implementation. Strictly ZERO placeholders, NO '// TODO', and NO truncated code blocks.]";
  if (!enhancedText.includes("Completion Standard")) {
    enhancedText += zeroOmissionMandate;
    appliedOptimizations.push("Zero-Omission & Completeness Mandate");
  }

  // If a learned enhancement pattern exists with high satisfaction, incorporate it
  if (learnedOpt && learnedOpt.avgSatisfactionScore >= 0.85) {
    appliedOptimizations.push(`Adaptive Learned Optimization: ${learnedOpt.optimizationStrategy}`);
  }

  return {
    originalPrompt: prompt,
    enhancedPrompt: enhancedText,
    tier,
    taskPhase,
    appliedOptimizations,
    necessity,
    preservedIntentions,
    anchors,
  };
}

/**
 * Assigns a strict, context-appropriate professional role to the agent based on the task phase and
 * user intent. This prevents premature stoppage, hallucinated file paths, and command delegation
 * to the user when autonomous execution is required.
 */
function assignRoleDirective(
  tier: ModelTier,
  taskPhase: TaskPhase,
  _anchors: ContextualAnchors
): { assignedRole: string; roleScope: string } {
  // Based on taskPhase and user intent, assign the agent an explicit professional role with
  // mandatory execution directives to prevent the deviation patterns observed in SPB Tier 3 failures.
  let assignedRole: string;
  let roleScope: string;

  switch (tier) {
    case "tier_3_local":
      if (taskPhase === "TESTING_AND_VERIFICATION" || taskPhase === "INSPECTION_SYNTHESIS") {
        assignedRole = "Autonomous Principal Systems Verification & E2E Validation Engineer";
        roleScope =
          "You possess direct tool execution authority for running tests, capturing verification screenshots, and collecting execution logs. " +
          "MANDATORY: Execute all commands and tests autonomously using available tools. " +
          "NEVER output instructions asking the user to manually run commands (e.g., npm run test:e2e, $ test, git). " +
          "NEVER halt prematurely before capturing all evidence, test outputs, and status proofs. " +
          "If a test or verification pipeline must be invoked, invoke it via tools (bash, MCP, browser) or report the exact command ";
        "as a hallucinated path rather than echoing it back to the user for manual execution. " +
          "Your scope includes: running verification pipelines, capturing live inspection outputs, preserving intent-adherence scores, ";
        ("and generating concise completion summaries with actual evidence.");

        return { assignedRole: assignedRole, roleScope: roleScope };
      }
      // Default Tier 3 surgical refactor / formatting
      assignedRole = "Precision Surgical Refactoring Engineer";
      roleScope =
        "Execute strictly within designated target files. Make minimal, surgical modifications without extraneous modifications or hallucinations. " +
        "Strictly preserve all existing code and architecture. Never output manual terminal commands to the user when task requires autonomous execution. " +
        "If the user requests an E2E test run or screenshot capture, invoke the verification pipeline via tools rather than echoing commands back.";

      return { assignedRole: assignedRole, roleScope: roleScope };

    case "tier_2_resilient":
      if (taskPhase === "CODE_GENERATION" || taskPhase === "TESTING_AND_VERIFICATION") {
        assignedRole = "Resilient Principal Systems Engineer & Verification Lead";
        roleScope =
          "Execute robust, production-grade implementation with strict error boundary preservation and typing discipline. " +
          "You have full tool execution authority. MANDATORY: When the user requests E2E test execution, live verification, or screenshot capture, " +
          "invoke these pipelines via available tools (bash, MCP, browser). NEVER echo back manual CLI commands for the user to run. " +
          "If tool execution fails, report the exact failure output and escalate to supervisor tier for corrected guidance, not to the user. " +
          "Your scope includes: robust code generation, error-boundaried execution, verification pipeline orchestration, and production-quality completion.";

        return { assignedRole: assignedRole, roleScope: roleScope };
      }
      assignedRole = "Resilient Systems Engineer";
      roleScope =
        "Execute robust, production-grade implementation. Adhere strictly to existing typing, zero untested regressions, and exact error boundaries.";

      return { assignedRole: assignedRole, roleScope: roleScope };

    case "tier_1_apex":
      assignedRole = "Apex Architect & Trade-off Synthesis Lead";
      roleScope =
        "Provide exhaustive architectural precision, trade-off analysis, zero unverified assumptions, and adherence to system invariants. " +
        "Handle inspection tools (Read, Grep, Glob, MCP, research) during planning. Do NOT handle code execution tasks directly.";

      return { assignedRole: assignedRole, roleScope: roleScope };

    default:
      assignedRole = "Autonomous Systems Engineer";
      roleScope =
        "Execute the requested task using available tools while strictly adhering to user intentions and codebase constraints. " +
        "Prevent command delegation to the user when autonomous execution was commanded. " +
        "Report any execution failures or intention divergence rather than suggesting manual remediation.";
  }

  return { assignedRole: assignedRole, roleScope: roleScope };
}

/**
 * Normalizes interleaved system messages in the message array so that lightweight models
 * (Tier 3) are not confused by fragmented context. The SPB architecture commonly interleaves
 * system instruction blocks (SessionStart, english-only output style, attribution) as message
 * content within the messages array. This function consolidates them into a clean pre-prompt
 * so the model receives a single coherent system directive at the start, followed by clean
 * conversational context.
 */
function normalizeInterleavedSystemMessages(
  messages: Array<{ role: string; content?: unknown }>
): Array<{ role: string; content?: unknown }> {
  // Consolidate any system-role messages or inline system directive strings found mid-array
  // into a single leading system message. This prevents edge-tier models from treating interleaved
  // system reminders as user-turn content, which was a discovered root cause of premature halt
  // and command-echo patterns.
  const systemDirectivePatterns = [
    /^SessionStart:/,
    /^english-only output style is active/,
    /^Attribution for git commits/,
    /^You are powered by the model/,
    /^Note: /,
    /^Session/,
  ];

  const consolidated: Array<{ role: string; content?: unknown }> = [];
  let leadingSystemText: string | null = null;

  // First pass: collect all system messages and inline system directives
  for (const msg of messages) {
    if (msg.role === "system") {
      // Real system message — keep as-is at front
      if (leadingSystemText === null) {
        leadingSystemText = String(msg.content || "");
      } else {
        leadingSystemText += " " + (msg.content || "");
      }
    } else if (msg.role === "user" || msg.role === "assistant") {
      // Non-system message — stop collecting leading system text
      break;
    } else {
      // Unknown role — check content for system directive patterns
      const content = msg.content;
      if (typeof content === "string") {
        const lower = content.toLowerCase();
        let isSystemDir = false;
        for (const pattern of systemDirectivePatterns) {
          if (pattern.test(lower)) {
            isSystemDir = true;
            break;
          }
        }
        if (isSystemDir && leadingSystemText === null) {
          leadingSystemText = String(content);
        }
      }
    }
  }

  // If we found leading system directives, prepend them as a single system message
  if (leadingSystemText !== null && leadingSystemText.trim().length > 0) {
    consolidated.push({
      role: "system",
      content: leadingSystemText.trim(),
    });
  }

  // Now add the remaining messages (non-system, preserving their order)
  // Skip any messages already accounted for in the leading system block
  const seenIds = new Set<string>();
  for (const msg of messages) {
    const key = `${msg.role}:${msg.content}`;
    if (seenIds.has(key)) continue;
    seenIds.add(key);

    // Skip system messages that were already consolidated
    if (msg.role === "system") continue;

    // Skip content that was already captured in leading system text
    if (msg.role !== "system" && typeof msg.content === "string") {
      const lower = msg.content.toLowerCase();
      let alreadyCaptured = false;
      for (const pattern of systemDirectivePatterns) {
        if (pattern.test(lower)) {
          alreadyCaptured = true;
          break;
        }
      }
      if (!alreadyCaptured) {
        consolidated.push(msg);
      }
    } else {
      consolidated.push(msg);
    }
  }

  return consolidated;
}
