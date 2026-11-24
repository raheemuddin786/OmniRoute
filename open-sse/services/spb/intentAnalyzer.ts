/**
 * SPB-IR Task Intent Analyzer
 * Classifies incoming request payloads, prompt structures, and tool definitions
 * into task phases and computes token depth profiles for intelligent routing.
 */
import { classifyPromptIntent, type IntentType } from "../intentClassifier.ts";
import { mapIntentToTaskFitnessKey } from "../autoCombo/intentTaskFitnessMap.ts";

import { getTierConfig } from "../tierResolver.ts";

export type TaskPhase =
  | "ARCHITECTURAL_PLANNING"
  | "CODE_GENERATION"
  | "TESTING_AND_VERIFICATION"
  | "FAST_REFACTOR"
  | "DETERMINISTIC_ROUTING"
  | "INSPECTION_SYNTHESIS"
  | "IMAGE_GENERATION";

export type IntentKind = "explicit" | "required-implied" | "optional";
export type IntentLayer = "ui" | "api" | "data" | "test" | "config" | "docs";
export type IntentStatus =
  "open" | "in_progress" | "done" | "done_unverified" | "blocked" | "skipped";
export type IntentGap = "exists" | "partial" | "missing";

export interface IntentLedgerItem {
  id: string; // e.g. "I1", "I2"
  parentId?: string; // If required-implied, references parent explicit ID
  reason?: string; // Justification for required-implied requirement
  text: string;
  kind: IntentKind;
  layer: IntentLayer;
  gap?: IntentGap;
  targetFiles?: string[];
  acceptance: string;
  status: IntentStatus;
  evidence?: string;
}

export interface GuidanceContract {
  supervisorTier?: "tier_1_apex" | "tier_2_resilient" | string;
  origin?: "supervisor" | "auto";
  taskSpecification?: string;
  constraints?: string[];
  instructions?: string[];
  targetFiles?: string[];
  verificationCriteria?: string[];
  intents?: IntentLedgerItem[];
  nonGoals?: string[];
  contextSource?: "repo" | "conversation";
  sharedWorkspace?: boolean;
  strictCompletion?: boolean;
  consecutiveNoChangeReprompts?: number;
  lastStateDigest?: string;
  outOfScopeViolations?: string[];
  baselineModifiedFiles?: string[];
  baselineFileHashes?: Record<string, string>;
  baselineFileStats?: Record<string, { size: number; mtime: number; hash: string }>;
  observedReadFiles?: string[];
  testExecutionPassed?: boolean;
  baselineTestPassed?: boolean;
  archivedContracts?: unknown[];
  createdAt?: number;
  [key: string]: unknown;
}

export interface ToolFailureDiagnostic {
  toolName?: string;
  filePath?: string;
  errorReason:
    | "string_not_found"
    | "multiple_matches"
    | "no_changes"
    | "file_modified_since_read"
    | "tool_not_available"
    | "json_parse_error"
    | "generic_failure";
  rawErrorSnippet: string;
}

export interface IntentProfile {
  taskPhase: TaskPhase;
  estimatedTokens: number;
  requiresTools: boolean;
  complexityScore: number; // 0.0 to 1.0
  promptAnchorHash: string;
  isToolResultTurn: boolean;
  isCodeMutationToolResult?: boolean;
  isToolExecutionError?: boolean;
  toolFailureDiagnostic?: ToolFailureDiagnostic;
  isDuplicateFileRead?: boolean;
  duplicateFilePath?: string;
  guidanceContract?: GuidanceContract;
  originalPrompt?: string; // preserved context for recovery and debugging
  hasVisualOrCrashData?: boolean;
  hasTestOrDiagnosticFailure?: boolean;
}

interface ExtractedContent {
  userText: string;
  hasToolResult: boolean;
  toolResultText: string;
  hasVisualOrCrashData: boolean;
  hasTestOrDiagnosticFailure: boolean;
  hasToolExecutionError?: boolean;
  toolFailureDiagnostic?: ToolFailureDiagnostic;
}

function extractMessageContent(msg: { role: string; content?: unknown }): ExtractedContent {
  const content = msg.content;
  const crashKeywordsRegex =
    /\b(error|exception|fail(?:ed|ure)?|crash|fatal|traceback|syntaxerror|typeerror|referenceerror|broken|exited with code [1-9]|npm err!)\b/i;
  const testFailureRegex =
    /\b(failing|failed|assertionerror|test failed|vitest|jest|mocha|pytest|spec|assert|expect)\b/i;

  if (typeof content === "string") {
    const hasCrash = crashKeywordsRegex.test(content);
    return {
      userText: content,
      hasToolResult: false,
      toolResultText: "",
      hasVisualOrCrashData: hasCrash,
      hasTestOrDiagnosticFailure: hasCrash && testFailureRegex.test(content),
    };
  }
  if (!content) {
    return {
      userText: "",
      hasToolResult: false,
      toolResultText: "",
      hasVisualOrCrashData: false,
      hasTestOrDiagnosticFailure: false,
    };
  }
  let userText = "";
  let toolResultText = "";
  let hasToolResult = false;
  let hasVisualOrCrashData = false;
  let hasTestOrDiagnosticFailure = false;
  let hasToolExecutionError = false;
  let toolFailureDiagnostic: ToolFailureDiagnostic | undefined;

  const inspectToolResultForFailure = (
    res: string,
    isExplicitError: boolean,
    toolName?: string,
    filePath?: string
  ): void => {
    if (
      isExplicitError ||
      /(?:<tool_use_error>|InputValidationError|Target must exactly match|String to replace not found|Found \d+ matches of the string|No changes to make|File has been modified since read|No such tool available|PreToolUse.*?error|\[tool_error:\s*true\]|tool_error|outside this session|ENOENT|EACCES|command not found|exit code [1-9]|fatal:)/i.test(
        res
      )
    ) {
      hasToolExecutionError = true;

      let errorReason: ToolFailureDiagnostic["errorReason"] = "generic_failure";
      if (
        /String to replace not found|Target must exactly match|could not find target/i.test(res)
      ) {
        errorReason = "string_not_found";
      } else if (/Found \d+ matches|replace_all is false/i.test(res)) {
        errorReason = "multiple_matches";
      } else if (/No changes to make|exactly the same/i.test(res)) {
        errorReason = "no_changes";
      } else if (/File has been modified since read/i.test(res)) {
        errorReason = "file_modified_since_read";
      } else if (/No such tool available/i.test(res)) {
        errorReason = "tool_not_available";
      } else if (/could not be parsed as JSON|JSON\.parse|SyntaxError/i.test(res)) {
        errorReason = "json_parse_error";
      }

      toolFailureDiagnostic = {
        toolName,
        filePath,
        errorReason,
        rawErrorSnippet: res.slice(0, 300),
      };
    }
  };

  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") {
        userText += " " + part;
        if (crashKeywordsRegex.test(part)) hasVisualOrCrashData = true;
        if (testFailureRegex.test(part)) hasTestOrDiagnosticFailure = true;
      } else if (part && typeof part === "object") {
        const item = part as Record<string, unknown>;
        if (
          item.type === "image" ||
          item.type === "image_url" ||
          item.image ||
          item.source !== undefined
        ) {
          hasVisualOrCrashData = true;
        }

        if (item.type === "tool_result" || item.tool_use_id) {
          hasToolResult = true;
          const isExplicitError = item.is_error === true || item.status === "error";
          const res =
            typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
          toolResultText += " " + res;
          if (crashKeywordsRegex.test(res)) hasVisualOrCrashData = true;
          if (testFailureRegex.test(res)) hasTestOrDiagnosticFailure = true;
          inspectToolResultForFailure(res, isExplicitError);
        } else if (typeof item.text === "string") {
          userText += " " + item.text;
          if (crashKeywordsRegex.test(item.text)) hasVisualOrCrashData = true;
          if (testFailureRegex.test(item.text)) hasTestOrDiagnosticFailure = true;
        } else if (typeof item.content === "string") {
          userText += " " + item.content;
          if (crashKeywordsRegex.test(item.content)) hasVisualOrCrashData = true;
          if (testFailureRegex.test(item.content)) hasTestOrDiagnosticFailure = true;
        }
      }
    }
  } else if (typeof content === "object") {
    const item = content as Record<string, unknown>;
    if (
      item.type === "image" ||
      item.type === "image_url" ||
      item.image ||
      item.source !== undefined
    ) {
      hasVisualOrCrashData = true;
    }

    if (item.type === "tool_result" || item.tool_use_id) {
      hasToolResult = true;
      const isExplicitError = item.is_error === true || item.status === "error";
      const res =
        typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
      toolResultText += " " + res;
      if (crashKeywordsRegex.test(res)) hasVisualOrCrashData = true;
      if (testFailureRegex.test(res)) hasTestOrDiagnosticFailure = true;
      inspectToolResultForFailure(res, isExplicitError);
    } else if (typeof item.text === "string") {
      userText += " " + item.text;
      if (crashKeywordsRegex.test(item.text)) hasVisualOrCrashData = true;
      if (testFailureRegex.test(item.text)) hasTestOrDiagnosticFailure = true;
    } else if (typeof item.content === "string") {
      userText += " " + item.content;
      if (crashKeywordsRegex.test(item.content)) hasVisualOrCrashData = true;
      if (testFailureRegex.test(item.content)) hasTestOrDiagnosticFailure = true;
    }
  }

  return {
    userText: userText.trim(),
    hasToolResult,
    toolResultText: toolResultText.trim(),
    hasVisualOrCrashData,
    hasTestOrDiagnosticFailure,
    hasToolExecutionError,
    toolFailureDiagnostic,
  };
}

export function cleanUserInstruction(text: string): string {
  // Strip <system-reminder>...</system-reminder> blocks injected by agent environments
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
  if (
    cleaned === "(no content)" ||
    cleaned === "[Tool use interrupted]" ||
    cleaned === "no content"
  ) {
    return "";
  }
  return cleaned;
}

export function classifyIntent(
  messages: Array<{ role: string; content?: unknown }>,
  tools?: unknown[]
): IntentProfile {
  let totalChars = 0;

  // Agent environment & thinking indicators
  const complexReasoningRegex =
    /\b(think deeply|deep thinking|deep reasoning|reasoning effort|think step by step|chain of thought|deliberate|evaluate trade-offs|comparative analysis|high-level strategy|synthesis|synthesize|holistic review)\b/i;
  const planModeRegex =
    /\b(plan mode|planning mode|enter plan mode|implementation plan|architectural blueprint|system architecture|architectural design|architectural planning|software architecture|distributed systems?|microservices architecture|rfc proposal|system rfc|formal proof|algorithmic proof|strategic planning|multi-tier architecture|threat model(?:ing)?|apex reasoning|sdlc plan|execution plan|autonomous execution plan|plan only|generate a plan|create a plan|sdlc checklist|make a plan)\b/i;

  const purePlanningPhrasesRegex =
    /\b(plan mode|planning mode|enter plan mode|implementation plan|architectural blueprint|system architecture|architectural design|architectural planning|software architecture|threat model(?:ing)?|rfc proposal|system rfc|sdlc plan|execution plan|autonomous execution plan|plan only|generate a plan|create a plan|sdlc checklist|make a plan)\b/i;

  const codeRegex =
    /\b(function(?:s)?|class(?:es)?|const|let|var|import|export|def|return|async|await|interface|type|code|implement(?:s|ed|ing)?|component(?:s)?|typescript|javascript|python|rust|golang|sql|query|endpoint(?:s)?|controller(?:s)?|service(?:s)?|bug(?:s)?|fix(?:es|ed|ing)?|debug(?:ging)?|patch(?:es|ed|ing)?|issue(?:s)?|script(?:s)?|module(?:s)?|file(?:s)?|method(?:s)?|build(?:ing)?|write|writing|written)\b/i;

  const architectureRegex =
    /\b(system architecture|architectural design|architectural planning|software architecture|distributed systems?|microservices architecture|rfc proposal|system rfc|complex reasoning|formal proof|algorithmic proof|strategic planning|multi-tier architecture|threat model(?:ing)?|deep thinking|deep reasoning|apex reasoning)\b/i;
  const architectureWordRegex = /\b(architect|architecture|architectural)\b/i;

  const testRegex =
    /\b(test|assert|spec|coverage|failing|assertion|jest|vitest|mocha|pytest|unit test|integration test|e2e test)\b/i;

  const refactorRegex =
    /\b(refactor|clean up|simplify|rename|extract|lint|beautify|prettify|indent|typo|comment|docs?string)\b/i;

  const deterministicRegex =
    /\b(format|json|csv|yaml|markdown table|sort|deduplicate|escape|unescape|normalize)\b/i;

  const imageGenerationRegex =
    /\b(?:generate|create|render|draw|make|design)\b.*?\b(?:image|photo|picture|illustration|visual|photorealistic|portrait|artwork|graphic|poster|brochure image)\b|\b(?:realistic images?|generate images?|image generation|photo generation|text-to-image|txt2img)\b/i;

  // Strict execution indicators that distinguish active bug fixing / code writing from planning
  const executionFixBugRegex =
    /\b(fix (?:the |a )?bug|resolve error|debug failing|patch the code)\b/i;

  // Extract content across all messages
  const userMessages = messages.filter((m) => m.role === "user");
  const extractedUserMessages = userMessages.map(extractMessageContent);

  for (const msg of messages) {
    const ext = extractMessageContent(msg);
    totalChars += ext.userText.length + ext.toolResultText.length;
  }

  const latestExtracted =
    extractedUserMessages.length > 0
      ? extractedUserMessages[extractedUserMessages.length - 1]
      : { userText: "", hasToolResult: false, toolResultText: "" };

  const isToolResultTurn = latestExtracted.hasToolResult;
  let activeHumanText = cleanUserInstruction(latestExtracted.userText);

  // If latest user turn had no human text (e.g. tool result only or empty), inspect prior user turns for the prompt context
  if (activeHumanText.length === 0) {
    for (let i = extractedUserMessages.length - 2; i >= 0; i--) {
      const priorText = cleanUserInstruction(extractedUserMessages[i].userText);
      if (priorText.length > 0) {
        activeHumanText = priorText;
        break;
      }
    }
  }

  // CRITICAL FIX: preserve comprehensive intent beyond just latest human text
  // track the original prompt anchor from the FIRST user message for context preservation
  const firstUserMessage = userMessages[0];
  const firstUserExtracted = firstUserMessage ? extractMessageContent(firstUserMessage) : null;
  const originalPromptText = firstUserExtracted
    ? cleanUserInstruction(firstUserExtracted.userText)
    : "";

  const targetText = activeHumanText;

  // MULTILINGUAL INTENT CLASSIFICATION (first pass) - Use multilingual classifier for accurate intent detection
  // This runs BEFORE keyword-based classification to inform/override English-only keyword logic
  const multilingualIntent: IntentType = classifyPromptIntent(targetText);
  const multilingualTaskType = mapIntentToTaskFitnessKey(multilingualIntent);
  const multilingualPhaseHint = (() => {
    switch (multilingualTaskType) {
      case "coding":
        return "CODE_GENERATION";
      case "analysis":
        return "ARCHITECTURAL_PLANNING";
      case "planning":
        return "ARCHITECTURAL_PLANNING";
      case "review":
        return "TESTING_AND_VERIFICATION";
      case "debugging":
        return "TESTING_AND_VERIFICATION";
      case "documentation":
        return "INSPECTION_SYNTHESIS";
      case "default":
        return null;
    }
  })();

  // MULTILINGUAL INTENT CLASSIFICATION END

  // Detect code modification / mutation tools from tool results, tool names, or user text

  // Detect code modification / mutation tools from tool results, tool names, or user text
  // 1. Check if the tool executed was an explicit mutation tool (Edit, Write, write_file, edit_file, patch)
  const mutationToolNameRegex =
    /^(?:edit|write|write_file|edit_file|file_write|patch|apply_diff|save_file|create_file)$/i;
  let isMutationToolName = false;
  let executedToolName: string | undefined;
  let executedFilePath: string | undefined;

  if (isToolResultTurn) {
    // Check tool_use calls in the conversation matching the tool results
    const recentAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (recentAssistant && Array.isArray(recentAssistant.content)) {
      for (const part of recentAssistant.content) {
        if (part && typeof part === "object") {
          const item = part as Record<string, unknown>;
          if (item.type === "tool_use" && typeof item.name === "string") {
            executedToolName = item.name;
            const input = item.input as Record<string, unknown> | undefined;
            if (input && typeof input === "object") {
              const fp = input.file_path || input.filePath || input.path || input.filename;
              if (typeof fp === "string") executedFilePath = fp;
            }
            if (mutationToolNameRegex.test(item.name)) {
              isMutationToolName = true;
            }
          }
        }
      }
    }
  }

  // Enrich diagnostic with detected tool name and file path if available
  if (latestExtracted.toolFailureDiagnostic) {
    if (!latestExtracted.toolFailureDiagnostic.toolName && executedToolName) {
      latestExtracted.toolFailureDiagnostic.toolName = executedToolName;
    }
    if (!latestExtracted.toolFailureDiagnostic.filePath && executedFilePath) {
      latestExtracted.toolFailureDiagnostic.filePath = executedFilePath;
    }
  }

  const isCodeMutationToolResult =
    isToolResultTurn &&
    (isMutationToolName ||
      /\b(edit|edits|edited|editing|write|writes|written|writing|file_write|write_file|patch|patches|patched|diff|diffs|applied|saved|commit|committed|updated|created|replaced)\b/i.test(
        latestExtracted.toolResultText
      ));

  // Architecture / Plan Mode / Complex Reasoning keywords are evaluated on user instruction or intent
  // Tier 1 is reserved for architectural planning, plan mode, and apex reasoning.
  // Inspection tools (Read, Grep, Glob, MCP, WebSearch) during active plan mode remain in Tier 1.
  // When a tool result turn arrives without any prior explicit plan mode directive, default tool results to Tier 2.
  const isExplicitPlanningPhrase = purePlanningPhrasesRegex.test(targetText);
  const hasPureArchitectureIntent =
    !isCodeMutationToolResult &&
    !executionFixBugRegex.test(targetText) &&
    (isToolResultTurn
      ? isExplicitPlanningPhrase
      : isExplicitPlanningPhrase ||
        ((architectureRegex.test(targetText) ||
          architectureWordRegex.test(targetText) ||
          planModeRegex.test(targetText) ||
          complexReasoningRegex.test(targetText)) &&
          !/\b(fix (?:the |a )?bug|debug|patch failing)\b/i.test(targetText)));

  const hasTestKeywords =
    testRegex.test(targetText) ||
    (isToolResultTurn && testRegex.test(latestExtracted.toolResultText));
  const hasRefactorKeywords = !isToolResultTurn && refactorRegex.test(targetText);
  const hasDeterministicKeywords = !isToolResultTurn && deterministicRegex.test(targetText);
  const hasCodeKeywords =
    codeRegex.test(targetText) ||
    (isToolResultTurn && codeRegex.test(latestExtracted.toolResultText));

  const clientHasTools = Array.isArray(tools) && tools.length > 0;
  // requiresTools is true for active tool loops (tool results) or whenever client tools are provided by the agent runtime
  const requiresTools = isToolResultTurn || clientHasTools;

  const estimatedTokens = Math.ceil(totalChars / 4);

  // Compute prompt anchor hash for cache preservation
  const systemMessages = messages.filter((m) => m.role === "system");
  const anchorPayload = {
    system: systemMessages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")
    ),
    rootUser: firstUserMessage ? extractMessageContent(firstUserMessage).userText : "",
    tools: Array.isArray(tools) ? tools.length : 0,
  };
  const promptAnchorHash = simpleHash(JSON.stringify(anchorPayload));

  let taskPhase: TaskPhase = "DETERMINISTIC_ROUTING";
  let complexityScore = 0.2;

  // Intent Classification Hierarchy adhering strictly to tier responsibilities:
  // - Pure architectural planning / Plan mode (including research & inspection tool feedback): Tier 1 (Apex reasoning)
  // - Tool execution feedback (code mutation/tests): Tier 2 (Resilient execution & verification)
  // - Read-only inspection / exploration tool feedback: Tier 3 (Inspection synthesis)
  // - Test verification: Tier 2 (Testing & verification)
  // - Refactoring: Tier 3 (Fast refactor) - requires GuidanceContract from supervisor tiers
  // - Formatting / Deterministic: Tier 3 (Deterministic routing) - requires GuidanceContract from supervisor tiers
  // - Code generation / Tool execution: Tier 2 (Code generation)

  // THE CRITICAL ARCHITECTURAL CONSTRAINTS:
  // 1. Context-aware Human-Turn Tier 1 Planning:
  //    When a user request arrives on a direct human prompt (!isToolResultTurn),
  //    evaluate whether the context warrants structured architectural planning (Tier 1 Apex) to create
  //    tasks, goals, and constraints before Tier 2 / Tier 3 execute.
  //    Triggers when the prompt involves broad application adaptation, multi-step design, screen workflows,
  //    end-to-end features, research, audits, or explicit planning/architecture requests.
  // 2. All Tier 3 execution (FAST_REFACTOR, DETERMINISTIC_ROUTING) must have GuidanceContract from supervisor tiers.
  const isContinuationPhrase = /^(ok|yes|proceed|continue|go on|sure|fine|yep|done|next)$/i.test(
    targetText.trim()
  );
  const isDirectHumanPrompt =
    !isToolResultTurn && targetText.trim().length > 0 && !isContinuationPhrase;

  const isExplicitPureCodeExecution =
    /\b(implement(?:ing|ed|s)?|code|write|create the (?:code|file|component)|patch|fix|debug)\b/i.test(
      targetText
    ) &&
    !/\b(plan|planning|architect|architecture|blueprint|roadmap|research|investigate|audit|system architecture)\b/i.test(
      targetText
    );

  const isAutonomousSdlcPrompt =
    isDirectHumanPrompt &&
    /\b(sdlc|end-to-end autonomous|full autonomous|single prompt.*full|single execution.*single prompt|autonomous-executor|requirements.*architecture.*implementation.*testing)\b/i.test(
      targetText
    );

  const isBroadSystemContext =
    isAutonomousSdlcPrompt ||
    (isDirectHumanPrompt &&
      !isExplicitPureCodeExecution &&
      !hasDeterministicKeywords &&
      !hasTestKeywords &&
      !hasRefactorKeywords &&
      (/\b(adapt|screen|screens|app|mobile|redesign|system architecture|architectural|design flow|end-to-end|workflow|multi-page|multi-step|roadmap|blueprint|research|investigate|audit|plan|planning|strategy|deep analysis)\b/i.test(
        targetText
      ) ||
        (userMessages.length === 1 && !hasCodeKeywords)));

  // Multi-file mutation detection: if the request references > multiFileThreshold distinct source files for mutation/refactor,
  // route to ARCHITECTURAL_PLANNING to establish a supervisor guidance contract before delegating to Tier 2
  const currentConfig = getTierConfig();
  const multiFileThreshold = currentConfig?.spbConfig?.multiFileThreshold ?? 3;
  const duplicateReadThreshold = currentConfig?.spbConfig?.duplicateReadThreshold ?? 3;

  const referencedFileMatches = targetText.match(
    /(?:[a-zA-Z0-9_\-./]+\/)?(?:src|open-sse|tests|scripts|electron|lib|app|components)\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+/g
  );
  const uniqueReferencedFiles = new Set(referencedFileMatches || []);
  const isMultiFileMutation =
    isDirectHumanPrompt &&
    uniqueReferencedFiles.size > multiFileThreshold &&
    (hasCodeKeywords || hasRefactorKeywords);

  // Duplicate file read loop guard:
  // Track files being inspected across rolling assistant/user tool turns.
  // If an agent calls Read/inspect on the SAME file >= duplicateReadThreshold times without an intervening
  // code mutation, force CODE_GENERATION to break the infinite read loop.
  let isDuplicateFileRead = false;
  let duplicateFilePath: string | undefined;

  const fileReadCounts = new Map<string, number>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const rawTools: Array<{ name: string; args?: Record<string, unknown> }> = [];
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            part &&
            typeof part === "object" &&
            (part as Record<string, unknown>).type === "tool_use"
          ) {
            const t = part as { name?: string; input?: Record<string, unknown> };
            if (t.name) rawTools.push({ name: t.name, args: t.input });
          }
        }
      }
      const toolCalls = (msg as Record<string, unknown>).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (tc && typeof tc === "object") {
            const fn = (tc as { function?: { name?: string; arguments?: unknown } }).function;
            if (fn?.name) {
              let parsedArgs: Record<string, unknown> = {};
              if (typeof fn.arguments === "string") {
                try {
                  parsedArgs = JSON.parse(fn.arguments);
                } catch {}
              } else if (typeof fn.arguments === "object" && fn.arguments !== null) {
                parsedArgs = fn.arguments as Record<string, unknown>;
              }
              rawTools.push({ name: fn.name, args: parsedArgs });
            }
          }
        }
      }

      for (const tool of rawTools) {
        const toolName = (tool.name || "").toLowerCase();
        const args = tool.args || {};
        const filePath = String(
          args.file_path || args.filePath || args.path || args.filename || ""
        ).trim();
        const isReadTool =
          /^(read|read_file|view|readlocalfile|cat)$/i.test(toolName) || toolName.includes("read");
        const isMutationTool =
          /^(write|edit|file_write|patch|update|apply_patch)$/i.test(toolName) ||
          toolName.includes("write") ||
          toolName.includes("edit");

        if (isReadTool && filePath) {
          const count = (fileReadCounts.get(filePath) || 0) + 1;
          fileReadCounts.set(filePath, count);
          if (count >= duplicateReadThreshold) {
            isDuplicateFileRead = true;
            duplicateFilePath = filePath;
          }
        } else if (isMutationTool && filePath) {
          fileReadCounts.delete(filePath);
        }
      }
    }
  }

  // Check explicit architecture/planning keyword signals first
  if (hasPureArchitectureIntent || isBroadSystemContext || isMultiFileMutation) {
    taskPhase = "ARCHITECTURAL_PLANNING";
    complexityScore = hasPureArchitectureIntent ? 0.9 : isMultiFileMutation ? 0.88 : 0.85;
  } else if (isDuplicateFileRead) {
    // Hard break: repeated reading of the same file forces immediate code generation
    taskPhase = "CODE_GENERATION";
    complexityScore = 0.75;
  } else if (isToolResultTurn) {
    if (hasTestKeywords) {
      taskPhase = "TESTING_AND_VERIFICATION";
      complexityScore = 0.6;
    } else if (isCodeMutationToolResult) {
      taskPhase = "CODE_GENERATION";
      complexityScore = 0.65;
    } else {
      taskPhase = "INSPECTION_SYNTHESIS";
      complexityScore = 0.3;
    }
  } else if (hasTestKeywords) {
    taskPhase = "TESTING_AND_VERIFICATION";
    complexityScore = 0.6;
  } else if (hasRefactorKeywords) {
    taskPhase = "FAST_REFACTOR";
    complexityScore = 0.25;
  } else if (hasDeterministicKeywords) {
    taskPhase = "DETERMINISTIC_ROUTING";
    complexityScore = 0.15;
  } else if (imageGenerationRegex.test(targetText)) {
    taskPhase = "IMAGE_GENERATION";
    complexityScore = 0.7;
  } else if (hasCodeKeywords || requiresTools) {
    taskPhase = "CODE_GENERATION";
    complexityScore = 0.65;
  } else if (multilingualPhaseHint) {
    taskPhase = multilingualPhaseHint;
    complexityScore = 0.7;
  }

  return {
    taskPhase,
    estimatedTokens,
    requiresTools,
    complexityScore,
    promptAnchorHash,
    isToolResultTurn,
    isCodeMutationToolResult: !!isCodeMutationToolResult,
    isToolExecutionError: Boolean(latestExtracted.hasToolExecutionError),
    toolFailureDiagnostic: latestExtracted.toolFailureDiagnostic,
    isDuplicateFileRead,
    duplicateFilePath,
    originalPrompt: originalPromptText || "",
    hasVisualOrCrashData: latestExtracted.hasVisualOrCrashData,
    hasTestOrDiagnosticFailure: latestExtracted.hasTestOrDiagnosticFailure,
  };
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return "sha256:spb_" + Math.abs(hash).toString(16).padStart(16, "0");
}
