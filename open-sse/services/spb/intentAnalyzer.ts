/**
 * SPB-IR Task Intent Analyzer
 * Classifies incoming request payloads, prompt structures, and tool definitions
 * into task phases and computes token depth profiles for intelligent routing.
 */

export type TaskPhase =
  | "ARCHITECTURAL_PLANNING"
  | "CODE_GENERATION"
  | "TESTING_AND_VERIFICATION"
  | "FAST_REFACTOR"
  | "DETERMINISTIC_ROUTING";

export interface IntentProfile {
  taskPhase: TaskPhase;
  estimatedTokens: number;
  requiresTools: boolean;
  complexityScore: number; // 0.0 to 1.0
  promptAnchorHash: string;
  isToolResultTurn: boolean;
}

interface ExtractedContent {
  userText: string;
  hasToolResult: boolean;
  toolResultText: string;
}

function extractMessageContent(msg: { role: string; content?: unknown }): ExtractedContent {
  const content = msg.content;
  if (typeof content === "string") {
    return { userText: content, hasToolResult: false, toolResultText: "" };
  }
  if (!content) {
    return { userText: "", hasToolResult: false, toolResultText: "" };
  }
  let userText = "";
  let toolResultText = "";
  let hasToolResult = false;

  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") {
        userText += " " + part;
      } else if (part && typeof part === "object") {
        const item = part as Record<string, unknown>;
        if (item.type === "tool_result" || item.tool_use_id) {
          hasToolResult = true;
          const res =
            typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
          toolResultText += " " + res;
        } else if (typeof item.text === "string") {
          userText += " " + item.text;
        } else if (typeof item.content === "string") {
          userText += " " + item.content;
        }
      }
    }
  } else if (typeof content === "object") {
    const item = content as Record<string, unknown>;
    if (item.type === "tool_result" || item.tool_use_id) {
      hasToolResult = true;
      const res =
        typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
      toolResultText += " " + res;
    } else if (typeof item.text === "string") {
      userText = item.text;
    } else if (typeof item.content === "string") {
      userText = item.content;
    }
  }

  return {
    userText: userText.trim(),
    hasToolResult,
    toolResultText: toolResultText.trim(),
  };
}

function cleanUserInstruction(text: string): string {
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
    /\b(plan mode|planning mode|enter plan mode|implementation plan|architectural blueprint|system architecture|architectural design|architectural planning|software architecture|distributed systems?|microservices architecture|rfc proposal|system rfc|formal proof|algorithmic proof|strategic planning|multi-tier architecture|threat model(?:ing)?|apex reasoning)\b/i;

  const purePlanningPhrasesRegex =
    /\b(plan mode|planning mode|enter plan mode|implementation plan|architectural blueprint|system architecture|architectural design|architectural planning|software architecture|threat model(?:ing)?|rfc proposal|system rfc)\b/i;

  const codeRegex =
    /\b(function|class|const|let|var|import|export|def|return|async|await|interface|type|code|implement|typescript|javascript|python|rust|golang|sql|query|endpoint|controller|service|component|bug|fix|debug|patch|issue|script|module|file|method)\b/i;

  const architectureRegex =
    /\b(system architecture|architectural design|architectural planning|software architecture|distributed systems?|microservices architecture|rfc proposal|system rfc|complex reasoning|formal proof|algorithmic proof|strategic planning|multi-tier architecture|threat model(?:ing)?|deep thinking|deep reasoning|apex reasoning)\b/i;
  const architectureWordRegex = /\b(architect|architecture|architectural)\b/i;

  const testRegex =
    /\b(test|assert|spec|coverage|failing|assertion|jest|vitest|mocha|pytest|unit test|integration test|e2e test)\b/i;

  const refactorRegex =
    /\b(refactor|clean up|simplify|rename|extract|lint|beautify|prettify|indent|typo|comment|docs?string)\b/i;

  const deterministicRegex =
    /\b(format|json|csv|yaml|markdown table|sort|deduplicate|escape|unescape|normalize)\b/i;

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

  const targetText = activeHumanText;

  // Architecture / Plan Mode / Complex Reasoning keywords are evaluated on user instruction or intent
  // Tier 1 is reserved for architectural planning, plan mode, and apex reasoning (when not in middle of tool-execution loops)
  // Phrases explicitly indicating plan mode / architectural planning take precedence unless actively fixing bugs or in tool results.
  const isExplicitPlanningPhrase = purePlanningPhrasesRegex.test(targetText);
  const hasPureArchitectureIntent =
    !isToolResultTurn &&
    !executionFixBugRegex.test(targetText) &&
    (isExplicitPlanningPhrase ||
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
  const firstUserMessage = userMessages[0];
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
  // - Tool execution feedback: Tier 2 (Resilient execution & verification)
  // - Pure architectural planning: Tier 1 (Apex reasoning)
  // - Test verification: Tier 2 (Testing & verification)
  // - Refactoring: Tier 3 (Fast refactor)
  // - Formatting / Deterministic: Tier 3 (Deterministic routing)
  // - Code generation / Tool execution: Tier 2 (Code generation)
  if (isToolResultTurn) {
    if (hasTestKeywords) {
      taskPhase = "TESTING_AND_VERIFICATION";
      complexityScore = 0.6;
    } else {
      taskPhase = "CODE_GENERATION";
      complexityScore = 0.65;
    }
  } else if (hasPureArchitectureIntent) {
    taskPhase = "ARCHITECTURAL_PLANNING";
    complexityScore = 0.9;
  } else if (hasTestKeywords) {
    taskPhase = "TESTING_AND_VERIFICATION";
    complexityScore = 0.6;
  } else if (hasRefactorKeywords) {
    taskPhase = "FAST_REFACTOR";
    complexityScore = 0.25;
  } else if (hasDeterministicKeywords) {
    taskPhase = "DETERMINISTIC_ROUTING";
    complexityScore = 0.15;
  } else if (hasCodeKeywords || requiresTools) {
    taskPhase = "CODE_GENERATION";
    complexityScore = 0.65;
  }

  return {
    taskPhase,
    estimatedTokens,
    requiresTools,
    complexityScore,
    promptAnchorHash,
    isToolResultTurn,
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
