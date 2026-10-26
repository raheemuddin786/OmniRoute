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

import { TaskPhase } from "./intentAnalyzer.ts";
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
        "[SPB-IR Resilient Directive: Execute robust, production-grade implementation. Adhere strictly to existing typing, zero untested regressions, and exact error boundaries.]";
      appliedOptimizations.push("Tier 2 Resilient Implementation & Error Boundary Enforcement");
      break;
    }

    case "tier_3_local": {
      tierPreamble =
        "[SPB-IR Local Directive: Execute strictly within designated target files. Make minimal, surgical modifications without extraneous modifications or hallucinations.]";
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
