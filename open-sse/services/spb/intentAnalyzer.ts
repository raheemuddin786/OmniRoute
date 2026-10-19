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
}

export function classifyIntent(
  messages: Array<{ role: string; content?: string }>,
  tools?: unknown[]
): IntentProfile {
  let totalChars = 0;
  let userText = "";
  let allText = "";

  const codeRegex =
    /\b(function|class|const|let|var|import|export|def|return|async|await|interface|type|code|implement|typescript|javascript|python|rust|golang|sql|query|endpoint|controller|service|component)\b/i;

  // Specific architectural planning keywords. Avoid generic words like 'system', 'design', 'workflow', 'pipeline'
  const architectureRegex =
    /\b(system architecture|architectural design|architectural planning|software architecture|distributed systems?|microservices architecture|rfc proposal|system rfc|complex reasoning|formal proof|algorithmic proof|strategic planning|multi-tier architecture|threat model(?:ing)?|deep thinking|deep reasoning|apex reasoning)\b/i;
  const architectureWordRegex = /\b(architect|architecture|architectural)\b/i;

  const testRegex =
    /\b(test|assert|spec|coverage|failing|assertion|jest|vitest|mocha|pytest|unit test|integration test|e2e test)\b/i;

  const refactorRegex =
    /\b(refactor|clean up|simplify|rename|extract|lint|beautify|prettify|indent|typo|comment|docs?string)\b/i;

  const deterministicRegex =
    /\b(format|json|csv|yaml|markdown table|sort|deduplicate|escape|unescape|normalize)\b/i;

  // Inspect messages: user messages drive the active task intent, while system messages provide general instructions
  const userMessages = messages.filter((m) => m.role === "user");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  const latestUserMessage = userMessages[userMessages.length - 1];
  const latestUserText =
    typeof latestUserMessage?.content === "string" ? latestUserMessage.content : "";

  for (const msg of messages) {
    const text = typeof msg.content === "string" ? msg.content : "";
    totalChars += text.length;
    allText += " " + text;
  }

  for (const msg of nonSystemMessages) {
    const text = typeof msg.content === "string" ? msg.content : "";
    userText += " " + text;
  }

  // Active turn instruction is driven by the latest user message.
  // Fall back to broader user context or allText only if the latest turn provides no text.
  const targetText =
    latestUserText.trim().length > 0
      ? latestUserText
      : userText.trim().length > 0
        ? userText
        : allText;

  let hasArchitectureKeywords =
    architectureRegex.test(targetText) || architectureWordRegex.test(targetText);
  let hasTestKeywords = testRegex.test(targetText);
  let hasRefactorKeywords = refactorRegex.test(targetText);
  let hasDeterministicKeywords = deterministicRegex.test(targetText);
  let hasCodeKeywords = codeRegex.test(targetText);

  // If latest user turn had no specific keywords, check broader conversation context
  if (
    !hasArchitectureKeywords &&
    !hasTestKeywords &&
    !hasRefactorKeywords &&
    !hasDeterministicKeywords &&
    !hasCodeKeywords &&
    targetText !== allText
  ) {
    hasArchitectureKeywords =
      architectureRegex.test(allText) || architectureWordRegex.test(allText);
    hasTestKeywords = testRegex.test(allText);
    hasRefactorKeywords = refactorRegex.test(allText);
    hasDeterministicKeywords = deterministicRegex.test(allText);
    hasCodeKeywords = codeRegex.test(allText);
  }

  const estimatedTokens = Math.ceil(totalChars / 4);
  const requiresTools = Array.isArray(tools) && tools.length > 0;

  // Compute prompt anchor hash for cache preservation.
  const systemMessages = messages.filter((m) => m.role === "system");
  const firstUserMessage = userMessages[0];
  const anchorPayload = {
    system: systemMessages.map((m) => m.content || ""),
    rootUser: firstUserMessage?.content || "",
    tools: Array.isArray(tools) ? tools.length : 0,
  };
  const promptAnchorHash = simpleHash(JSON.stringify(anchorPayload));

  let taskPhase: TaskPhase = "DETERMINISTIC_ROUTING";
  let complexityScore = 0.2;

  // Intent Classification Hierarchy adhering strictly to tier responsibilities:
  // Tier 1: Reserved strictly for architectural planning and apex reasoning
  // Tier 2: Resilient execution, code generation, test iteration, and verification
  // Tier 3: Local/edge inference, refactoring, formatting, and deterministic tasks
  if (hasArchitectureKeywords) {
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
