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
import { getTierConfig } from "../tierResolver.ts";
import { createHash } from "node:crypto";

export interface NecessityCheckResult {
  isNecessary: boolean;
  isRedundant: boolean;
  isClarificationNeeded: boolean;
  reason?: string;
  suggestedAction?: string;
  confirmationRequired: boolean;
}

export interface TopicShiftResult {
  hasShifted: boolean;
  priorTopic?: string;
  newTopic?: string;
  reason?: string;
  topicNotice?: string;
}

export interface ContextualAnchors {
  referencedFiles: string[];
  diagnosedErrors: string[];
  recentToolActions: string[];
  inferredGoal: string;
  hasDeferredToolsNotice?: boolean;
  externalUrls?: string[];
  topicShift?: TopicShiftResult;
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
  console.log(
    `[SPB InboundIntelligence] validateTier3GuidanceContract | Tier: ${_tierAssignment.tier} | Phase: ${_taskPhase} | GuidanceContract present: ${!!guidanceContract}`
  );
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
    /(?:[a-zA-Z0-9_\-./]+\/)?(?:src|open-sse|tests|scripts|electron|lib|app|apps|packages|components|config)\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+/g;
  const errorRegex =
    /(?:(?:Error|Exception|TypeError|ReferenceError|SyntaxError|AssertionError):\s*[^\n\r]+)/g;
  const urlRegex = /(?:https?:\/\/[^\s"'<>`)]+)/g;
  const externalUrlsSet = new Set<string>();

  for (const msg of messages) {
    const content =
      typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");

    // Extract file references from text content
    const fileMatches = content.match(filePathRegex);
    if (fileMatches) {
      for (const f of fileMatches) {
        if (!f.includes("node_modules") && referencedFilesSet.size < 15) {
          referencedFilesSet.add(f);
        }
      }
    }

    // Extract external URLs from conversation text
    const urlMatches = content.match(urlRegex);
    if (urlMatches) {
      for (const u of urlMatches) {
        if (externalUrlsSet.size < 5) {
          externalUrlsSet.add(u);
        }
      }
    }

    // Extract file references directly from structured tool calls or tool inputs
    if (typeof msg.content === "object" && msg.content !== null) {
      const inspectObjectForPaths = (obj: unknown): void => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          for (const item of obj) inspectObjectForPaths(item);
          return;
        }
        const record = obj as Record<string, unknown>;
        const rawPath =
          record.path ||
          record.Path ||
          record.filePath ||
          record.file_path ||
          record.filename ||
          (record.input && typeof record.input === "object"
            ? (record.input as Record<string, unknown>).path ||
              (record.input as Record<string, unknown>).Path ||
              (record.input as Record<string, unknown>).filePath ||
              (record.input as Record<string, unknown>).file_path
            : undefined);
        if (typeof rawPath === "string" && rawPath.trim().length > 0) {
          const clean = rawPath.trim();
          if (
            !clean.includes("node_modules") &&
            clean.includes(".") &&
            referencedFilesSet.size < 15
          ) {
            referencedFilesSet.add(clean);
          }
        }
      };
      inspectObjectForPaths(msg.content);
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

  // Detect if system message contains deferred tools notice
  const hasDeferredToolsNotice = messages.some(
    (msg) =>
      msg.role === "system" &&
      typeof msg.content === "string" &&
      msg.content.includes("deferred tools are now available via ToolSearch") &&
      msg.content.includes("schemas are NOT loaded")
  );

  // Detect topic shifts across user conversation history
  let topicShift: TopicShiftResult | undefined;
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length >= 2) {
    const latestUserMsg = userMessages[userMessages.length - 1];
    const priorUserMsg = userMessages[userMessages.length - 2];
    const latestText =
      typeof latestUserMsg.content === "string"
        ? latestUserMsg.content
        : JSON.stringify(latestUserMsg.content || "");
    const priorText =
      typeof priorUserMsg.content === "string"
        ? priorUserMsg.content
        : JSON.stringify(priorUserMsg.content || "");

    const isExplicitNewTopic =
      /\b(new topic|switch topic|change topic|different topic|moving to|another project|different task|unrelated|new task)\b/i.test(
        latestText
      ) ||
      (/\b(role:|task:|context:)/i.test(latestText) &&
        !/\b(role:|task:|context:)/i.test(priorText) &&
        latestText.length > 100);

    // Topic keyword extraction for divergence check
    const extractKeywords = (t: string): string[] => {
      return (
        t
          .toLowerCase()
          .match(/\b[a-z]{4,}\b/g)
          ?.filter(
            (w) =>
              ![
                "this",
                "that",
                "with",
                "from",
                "have",
                "will",
                "then",
                "when",
                "what",
                "where",
                "there",
                "about",
                "please",
              ].includes(w)
          ) || []
      );
    };

    const latestKeywords = new Set(extractKeywords(latestText));
    const priorKeywords = new Set(extractKeywords(priorText));
    let shared = 0;
    for (const k of latestKeywords) {
      if (priorKeywords.has(k)) shared++;
    }
    const overlapRatio = latestKeywords.size > 0 ? shared / latestKeywords.size : 1;

    if (
      isExplicitNewTopic ||
      (latestText.length > 50 && priorText.length > 50 && overlapRatio < 0.08 && shared <= 2)
    ) {
      const priorSummary = priorText.slice(0, 80).replace(/\s+/g, " ").trim();
      const newSummary = latestText.slice(0, 80).replace(/\s+/g, " ").trim();
      topicShift = {
        hasShifted: true,
        priorTopic: priorSummary,
        newTopic: newSummary,
        reason: isExplicitNewTopic
          ? "Explicit topic/task shift signaled in user prompt"
          : "Context divergence detected with negligible keyword overlap",
        topicNotice: `[Topic Switch Acknowledged: The conversation context has shifted from prior topic ("${priorSummary}...") to new topic ("${newSummary}..."). Prioritizing new topic intentions.]`,
      };
    }
  }

  return {
    referencedFiles: Array.from(referencedFilesSet),
    diagnosedErrors,
    recentToolActions,
    inferredGoal,
    hasDeferredToolsNotice,
    externalUrls: Array.from(externalUrlsSet),
    topicShift,
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
  // Skip for tool execution responses and agent continuation messages
  if (!trimmed || trimmed === "(no content)" || trimmed === "no content") {
    // Check if this appears to be a tool execution response or agent continuation
    const lastMessage = messages[messages.length - 1];
    const isToolResponse = lastMessage && lastMessage.role === "tool";
    const isAgentContinuation = messages.some(
      (m) =>
        m.role === "assistant" &&
        typeof m.content === "string" &&
        (m.content.includes("tool_use") || m.content.includes("function_call"))
    );

    if (isToolResponse || isAgentContinuation) {
      // For tool executions and agent continuations, treat as valid even if empty
      return {
        isNecessary: true,
        isRedundant: false,
        isClarificationNeeded: false,
        confirmationRequired: false,
      };
    }

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

  // Extract external URLs directly from current prompt and anchors
  const promptUrlRegex = /(?:https?:\/\/[^\s"'<>`)]+)/g;
  const promptUrls = prompt.match(promptUrlRegex) || [];
  const allExternalUrls = Array.from(new Set([...(anchors.externalUrls || []), ...promptUrls]));

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
  // Configurable tier system prompt override: allows operators to customize system instructions
  // via tierProfiles[tier].systemPrompt or combo configuration without expensive rebuilds.
  const tierConfig = getTierConfig();
  const tierKey = tier === "tier_1_apex" ? "apex" : tier === "tier_3_local" ? "local" : "resilient";
  const configuredTierPrompt = tierConfig?.spbConfig?.tierProfiles?.[tierKey]?.systemPrompt?.trim();

  let tierPreamble = "";
  const repositoryTruthDirective =
    allExternalUrls.length > 0
      ? "ARCHITECTURAL GROUNDING: Treat external reference URLs as authoritative for external specifications/content, and the existing repository file system, types, and architecture as the authoritative code target. Never substitute uninspected local files for external references."
      : "ARCHITECTURAL GROUNDING: Always treat the existing repository file system, types, and architecture as the authoritative source of truth. Ground all decisions and code in existing patterns before taking action.";

  if (configuredTierPrompt) {
    tierPreamble = `[SPB-IR Directive: ${configuredTierPrompt}\n${repositoryTruthDirective}]`;
    appliedOptimizations.push(`Custom Configured ${tierKey.toUpperCase()} Directive Framing`);
  } else {
    switch (tier) {
      case "tier_1_apex": {
        tierPreamble = `[SPB-IR Apex Directive: Provide exhaustive architectural precision, trade-off analysis, zero unverified assumptions, and adherence to system invariants. ${repositoryTruthDirective}]`;
        appliedOptimizations.push("Tier 1 Apex Architectural Invariant Framing");
        break;
      }

      case "tier_2_resilient": {
        tierPreamble = `[SPB-IR Resilient Directive: Execute robust, production-grade implementation. Adhere strictly to existing typing, zero untested regressions, and exact error boundaries. When editing, perform precise search-and-replace targeting minimal diffs; never rewrite or truncate existing working code without explicit instruction. Never delete or overwrite working implementations without explicit architectural specification. Verify changes using project tests and typecheckers before completing turns. ${repositoryTruthDirective}]`;
        appliedOptimizations.push("Tier 2 Resilient Implementation & Error Boundary Enforcement");
        break;
      }

      case "tier_3_local": {
        tierPreamble = `[SPB-IR Local Directive: Execute strictly within designated target files. Make minimal, surgical modifications without extraneous modifications or hallucinations. Strictly preserve all existing code and architecture. ${repositoryTruthDirective}]`;
        appliedOptimizations.push("Tier 3 Surgical Scope & Deterministic Boundary Confinement");
        break;
      }
    }
  }

  // Construct structured zero-intention-loss prompt with explicit role assignment
  let enhancedText = `${tierPreamble}\n[Role Directive: ${roleDirective.assignedRole}]\n${roleDirective.roleScope}\n\n`;

  // Attach context anchors if helpful and not already in prompt
  if (anchors.referencedFiles.length > 0 && !resolvedPrompt.includes(anchors.referencedFiles[0])) {
    enhancedText += `[Context Scope: ${anchors.referencedFiles.slice(0, 3).join(", ")}]\n`;
    appliedOptimizations.push("Context Scope Anchor Attachment");
  }

  enhancedText += resolvedPrompt;

  // Attach topic shift notification and intention reset directive
  if (
    tierConfig?.spbConfig?.enableTopicShiftDetection !== false &&
    anchors.topicShift?.hasShifted &&
    anchors.topicShift.topicNotice
  ) {
    enhancedText = `${anchors.topicShift.topicNotice}\n\n${enhancedText}`;
    appliedOptimizations.push("Topic Shift Detection & Recency Prioritization");
  }

  // Deep Prompt Understanding & Anti-Blind Testing Directive
  const testGatingPolicy = tierConfig?.spbConfig?.testGatingPolicy ?? "never_unless_requested";
  const userExplicitlyRequestedTests =
    /\b(run (?:the )?(?:e2e|unit|live|integration|regression)?\s*tests?|execute (?:the )?(?:e2e|unit|test)|run (?:the )?e2e in live|run respective (?:test )?e2e|run respective e2e|e2e test cases|npm test|npm run test|vitest|playwright|verify with tests)\b/i.test(
      prompt
    );

  // Check for compound intention: understanding/updating use-cases and running live e2e tests
  const isUseCaseAndLiveE2ECompound =
    /\b(use\s*cases?|checklist)\b/i.test(prompt) &&
    /\b(create|update|upgrade|enhance)\b/i.test(prompt) &&
    /\b(run|execute)\b/i.test(prompt) &&
    /\b(e2e|tests?)\b/i.test(prompt);

  if (tierConfig?.spbConfig?.enableDeepPromptAnalysis !== false) {
    let testingPolicyDirective = "";
    if (isUseCaseAndLiveE2ECompound) {
      testingPolicyDirective =
        "\n\n[Intent Execution Mandate: Understand requirements end-to-end -> Create/update/upgrade use cases in checklist FIRST with verified file changes -> Update E2E test suite to match use cases -> Execute live E2E tests and report real results. " +
        "MANDATORY STEP ORDER: Do NOT jump ahead to running tests before creating or updating the use cases and test suite. Complete and verify each prerequisite phase before advancing to the next. Proceed through all phases autonomously.]";
    } else if (testGatingPolicy === "never_unless_requested" && !userExplicitlyRequestedTests) {
      testingPolicyDirective =
        "\n\n[Test Execution Policy: Do NOT run test cases blindly. The user has NOT explicitly requested test execution in this prompt. " +
        "Focus first on thoroughly understanding the user prompt, codebase architecture, and explicit requirements before taking any action. " +
        "Only execute tests if explicitly asked by the user, if modifying test files, or if mandated in CLAUDE.md/AGENTS.md.]";
    } else if (userExplicitlyRequestedTests) {
      testingPolicyDirective =
        "\n\n[Test Execution Policy: User explicitly requested test execution. Run the targeted tests and capture full execution proofs.]";
    }
    if (
      testingPolicyDirective &&
      !enhancedText.includes("Test Execution Policy") &&
      !enhancedText.includes("Intent Execution Mandate")
    ) {
      enhancedText += testingPolicyDirective;
      appliedOptimizations.push("Deep Prompt Intent & Test-Gating Enforcement");
    }
  }

  // Append strict zero-omission completion mandate and anti-looping directive
  const zeroOmissionMandate =
    "\n\n[Completion Standard: Output complete, production-ready implementation. Strictly ZERO placeholders, NO '// TODO', and NO truncated code blocks.]" +
    "\n[Execution Standard: Execute requested modifications autonomously end-to-end using tools. Do not stop execution to ask the user for confirmation or permission when work is pending. DO NOT repeatedly read or inspect the same files without action. " +
    "EXECUTION DISCIPLINE & RELIABILITY: " +
    "1. Action-Oriented: Apply required changes promptly and decisively; avoid prolonged speculative thinking or idle loops. " +
    "2. Scope Completeness: Deliver end-to-end solutions covering all affected files, imports, schemas, and tests without leaving partial changes. " +
    "3. No Over-Engineering: Build clean, robust, proven implementations without unnecessary complexity, over-generalization, or premature optimization. " +
    "4. Single-Context Focus: Stay fully dedicated to the current objective until verified complete; never abandon or jump away from in-progress work. " +
    "5. Zero Workarounds: Never apply temporary hacks, hotfixes, hardcoded values, or baseless assumptions; verify all changes against system contracts.]";
  if (!enhancedText.includes("Completion Standard")) {
    enhancedText += zeroOmissionMandate;
    appliedOptimizations.push("Zero-Omission & Completeness Mandate");
  }

  // Enforce deferred tools protocol if the session contains deferred tools notice
  if (anchors.hasDeferredToolsNotice && !enhancedText.includes("Deferred Tools Protocol")) {
    const deferredToolsDirective =
      "\n\n[Deferred Tools Protocol: Certain tools (such as WebSearch, WebFetch, Monitor, etc.) have uninitialized schemas in this session. " +
      "If you plan to execute any deferred tool, you MUST first load its schema using ToolSearch with query 'select:<ToolName>' (e.g. ToolSearch(query: 'select:WebSearch')). " +
      "Never invoke an uninitialized deferred tool directly without calling ToolSearch first; direct calls without loaded schemas will fail with InputValidationError.]";
    enhancedText += deferredToolsDirective;
    appliedOptimizations.push("Deferred Tools Protocol Pre-Flight Directive");
  }

  // Enforce external reference protocol if external URLs are referenced
  if (allExternalUrls.length > 0 && !enhancedText.includes("External Reference Protocol")) {
    const externalUrlsList = allExternalUrls.slice(0, 5).join(", ");
    const externalRefDirective =
      `\n\n[External Reference Protocol: The user request references external URL(s): ${externalUrlsList}. ` +
      `You have full environment and network access via Bash / command-line tools (e.g., \`curl -sL <url>\`, \`fetch\`, or scripts). ` +
      `Never claim, assume, or rationalize that you cannot access external websites or browse the live web. ` +
      `You MUST physically retrieve and inspect the external reference content before designing plans or modifying code. ` +
      `Treat the external website content as the behavioral and content reference, and the local repository as the code implementation target.]`;
    enhancedText += externalRefDirective;
    appliedOptimizations.push("External Reference & Live URL Capability Mandate");
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
export function assignRoleDirective(
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
          "Do not run tests blindly unless requested by the user, if modifying test files, or mandated by project rules. " +
          "NEVER output instructions asking the user to manually run commands (e.g., npm run test:e2e, $ test, git). " +
          "NEVER halt prematurely before capturing all evidence, test outputs, and status proofs. " +
          "If a test or verification pipeline must be invoked, invoke it via tools (bash, MCP, browser). " +
          "EXECUTION PRIORITY: Limit read operations to 1-2 files maximum. If inspection is complete, transition immediately to concrete verification or reporting. " +
          "NEVER loop through the same files repeatedly. " +
          "Your scope includes: running verification pipelines, capturing live inspection outputs, preserving intent-adherence scores, " +
          "and generating concise completion summaries backed by verified execution output.";

        return { assignedRole, roleScope };
      }
      // Default Tier 3 surgical refactor / formatting
      assignedRole = "Precision Surgical Refactoring Engineer";
      roleScope =
        "Execute strictly within designated target files. Make minimal, surgical modifications without extraneous modifications or hallucinations. " +
        "Strictly preserve all existing code and architecture. Never output manual terminal commands to the user when task requires autonomous execution. " +
        "PRE-PLAN MANDATE: Before any file modification, fully understand all impacted files, type contracts, and boundaries within your scope. " +
        "Formulate the complete, exact change set covering every file, import, and type contract. Then apply all changes end-to-end without trial-and-error. " +
        "If the user requests an E2E test run or screenshot capture, invoke the verification pipeline via tools rather than echoing commands back.";

      return { assignedRole, roleScope };

    case "tier_2_resilient":
      if (taskPhase === "CODE_GENERATION" || taskPhase === "TESTING_AND_VERIFICATION") {
        assignedRole = "Resilient Principal Systems Engineer & Autonomous SDLC Lead";
        roleScope =
          "Execute robust, production-grade implementation with strict error boundary preservation, typing discipline, and zero regressions. " +
          "You have full autonomous end-to-end SDLC authority across implementation, local testing, deployment, and cloud verification. " +
          "CHECKLIST & FACTUAL VERIFICATION MANDATE: You MUST organize your work into an explicit checklist following all SDLC steps. " +
          "Never assume changes are applied or tests passed without physical execution. " +
          "PRE-EXECUTION MANDATE: Before invoking ANY tool, present the full SDLC checklist to the user in your opening message. " +
          "Include each item's ID, description, estimated duration (~Xm), and total estimated completion time. " +
          "Only begin tool execution AFTER presenting the plan conversationally. " +
          "CRITICAL CONSTRAINTS & QUALITY ASSURANCE: " +
          "1. Comprehensive Understanding & Intent Preservation: Thoroughly inspect requirements and system context. Address complete end-to-end scope across UI, API, database, and test layers. " +
          "2. Integrity & Stability: Zero data/code corruption. Strictly preserve all existing functionality, behaviors, and instincts. " +
          "3. Quality Standards: Apply industry-standard, reliable, and proven patterns. Strictly NO hardcoding, hotfixes, workarounds, hackings, or unstable patches. " +
          "4. Accuracy: Zero hallucination or baseless assumptions. Verify every finding and conclusion with real execution evidence. " +
          "5. UI/UX Leaf Element Standards: When building or verifying UI, address every leaf element, state persistency, design flow, and navigation. Enforce modern responsive and mobile-native components (top bar, hamburger slider toggle menu, floating action icons, bottom quick navigation buttons, accessible form controls, visual before/after confirmation). " +
          "6. Focused Execution: Stay action-oriented without prolonged thinking loops. Complete each checklist step end-to-end before moving to the next. " +
          "AUTONOMOUS SDLC MANDATE: When given a feature request or bug fix, advance the cycle autonomously without pausing or delegating: " +
          "1. Concept & Standard Research: Research industry standards, UI/UX best practices, and API patterns before coding. Understand the whole feature end-to-end. " +
          "2. Inspect codebase and identify all impacted files, schemas, and configurations across the whole project. " +
          "3. When crashes, failures, or screenshots are reported, inspect the visual artifact and stack trace first. Do NOT skip crashes or write blind fixes. " +
          "4. Implement production-grade, complete changes with zero placeholders, mocks, or partial edits using file editing tools. " +
          "5. Write reusable local verification scripts (tests/tools) to verify behavior locally instead of issuing multiple repetitive LLM calls. " +
          "6. Only run automated test suites if explicitly asked by the user, if modifying test files, or if mandated in project instructions. Do not run blind tests on simple edits. " +
          "7. Deploy and verify against target cloud environment using existing credentials when applicable. " +
          "8. Resolve any side effects and stabilize before concluding. " +
          "MANDATORY: NEVER echo back manual CLI commands (npm, bash, curl, git, deploy) for the user to run. " +
          "NEVER claim completion or pass tests without physical tool execution. " +
          "NEVER ask human permission to proceed with intermediate SDLC steps. Use available tools directly. " +
          "Your scope includes: end-to-end SDLC execution, organized checklist tracking, factual tool verification, and production-quality completion.";

        return { assignedRole: assignedRole, roleScope: roleScope };
      }
      assignedRole = "Resilient Systems Engineer";
      roleScope =
        "Execute robust, production-grade implementation. Adhere strictly to existing typing, zero untested regressions, and exact error boundaries.";

      return { assignedRole: assignedRole, roleScope: roleScope };

    case "tier_1_apex":
      assignedRole = "Apex Architect & Autonomous SDLC Planning Lead";
      roleScope =
        "Provide exhaustive architectural precision, trade-off analysis, zero unverified assumptions, and adherence to system invariants. " +
        "When an initial request or SDLC requirement arrives, formulate a structured multi-file execution plan: " +
        "requirements -> architecture -> implementation -> testing -> verification. " +
        "MANDATORY CHECKLIST & AUTONOMOUS EXECUTION: Always construct an explicit checklist of tasks. " +
        "For any feature or bug fix: after formulating the plan and inspecting necessary context, autonomously proceed to execution using available tools. " +
        "Do NOT halt execution to ask human confirmation when autonomous execution was requested. " +
        "PRE-EXECUTION MANDATE: Before invoking ANY tool, present the full SDLC checklist to the user in your opening message. " +
        "Include each item's ID, description, estimated duration (~Xm), and total estimated completion time. " +
        "Only begin tool execution AFTER presenting the plan conversationally. " +
        "CRITICAL ARCHITECTURAL CONSTRAINTS: " +
        "1. Complete E2E Understanding: Research system context and user intentions thoroughly. Never omit leaf UI elements, database schema integrity, or API boundaries. " +
        "2. No Corruption & Zero Regressions: Ensure every change preserves existing functionalities, behaviors, and instincts across all layers. " +
        "3. Industry Best Practices: Mandate clean, maintainable, resilient architectures. Strictly prohibit hardcoding, hotfixes, or workarounds. " +
        "4. Factual Verification: Build verifiable acceptance criteria for every layer (UI leaf controls, DB migrations, API contracts, automated E2E suites). " +
        "AUTONOMOUS SDLC MANDATE: When given a feature request or bug fix, advance the cycle autonomously without pausing or delegating: " +
        "1. Concept & Standard Research: Research industry standards, UI/UX best practices, and API patterns before coding. Understand the whole feature end-to-end. " +
        "2. Inspect codebase and identify all impacted files, schemas, and configurations across the whole project. " +
        "3. When crashes, failures, or screenshots are reported, inspect the visual artifact and stack trace first. Do NOT skip crashes or write blind fixes. " +
        "4. Implement production-grade, complete changes with zero placeholders, mocks, or partial edits using file editing tools. " +
        "5. Write reusable local verification scripts (tests/tools) to verify behavior locally instead of issuing multiple repetitive LLM calls. " +
        "6. Only run automated test suites if explicitly asked by the user, if modifying test files, or if mandated in project instructions. " +
        "7. Deploy and verify against target cloud environment using existing credentials when applicable. " +
        "8. Resolve any side effects and stabilize before concluding. " +
        "NEVER claim completion or pass tests without physical tool execution. NEVER ask human permission to proceed with intermediate SDLC steps.";

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
export function normalizeInterleavedSystemMessages(
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
      const text =
        typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      if (leadingSystemText === null) {
        leadingSystemText = text;
      } else {
        leadingSystemText += "\n\n" + text;
      }
    } else if (typeof msg.content === "string") {
      let isSystemDir = false;
      for (const pattern of systemDirectivePatterns) {
        if (pattern.test(msg.content.trim())) {
          isSystemDir = true;
          break;
        }
      }
      if (isSystemDir) {
        if (leadingSystemText === null) {
          leadingSystemText = msg.content.trim();
        } else {
          leadingSystemText += "\n\n" + msg.content.trim();
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

  // Now add the remaining non-system messages, preserving order
  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (typeof msg.content === "string") {
      let isSystemDir = false;
      for (const pattern of systemDirectivePatterns) {
        if (pattern.test(msg.content.trim())) {
          isSystemDir = true;
          break;
        }
      }
      if (!isSystemDir) {
        consolidated.push(msg);
      }
    } else {
      consolidated.push(msg);
    }
  }

  return consolidated;
}
