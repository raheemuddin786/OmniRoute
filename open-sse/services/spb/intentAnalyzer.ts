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
  let hasCodeKeywords = false;
  let hasArchitectureKeywords = false;
  let hasTestKeywords = false;
  let hasRefactorKeywords = false;

  const codeRegex =
    /\b(function|class|const|let|var|import|export|def|return|async|await|interface|type|code|implement|typescript|javascript)\b/i;
  const architectureRegex =
    /\b(architect|architecture|architectural|system|design|rfc|distributed|scaling|microservices|workflow|pipeline)\b/i;
  const testRegex = /\b(test|assert|spec|coverage|fail|pass|mock|jest|vitest|mocha)\b/i;
  const refactorRegex = /\b(refactor|clean|simplify|rename|extract|format)\b/i;

  for (const msg of messages) {
    const text = typeof msg.content === "string" ? msg.content : "";
    totalChars += text.length;
    if (codeRegex.test(text)) hasCodeKeywords = true;
    if (architectureRegex.test(text)) hasArchitectureKeywords = true;
    if (testRegex.test(text)) hasTestKeywords = true;
    if (refactorRegex.test(text)) hasRefactorKeywords = true;
  }

  const estimatedTokens = Math.ceil(totalChars / 4);
  const requiresTools = Array.isArray(tools) && tools.length > 0;

  // Compute prompt anchor hash for cache preservation.
  // In accordance with KV cache prefix architectures, extract the invariant prompt root:
  // system prompt(s), initial user instruction, and tool signature count.
  const systemMessages = messages.filter((m) => m.role === "system");
  const firstUserMessage = messages.find((m) => m.role === "user");
  const anchorPayload = {
    system: systemMessages.map((m) => m.content || ""),
    rootUser: firstUserMessage?.content || "",
    tools: Array.isArray(tools) ? tools.length : 0,
  };
  const promptAnchorHash = simpleHash(JSON.stringify(anchorPayload));

  let taskPhase: TaskPhase = "DETERMINISTIC_ROUTING";
  let complexityScore = 0.2;

  if (hasArchitectureKeywords || estimatedTokens > 8000) {
    taskPhase = "ARCHITECTURAL_PLANNING";
    complexityScore = 0.9;
  } else if (hasTestKeywords) {
    taskPhase = "TESTING_AND_VERIFICATION";
    complexityScore = 0.7;
  } else if (hasRefactorKeywords && estimatedTokens < 3000) {
    taskPhase = "FAST_REFACTOR";
    complexityScore = 0.4;
  } else if (hasCodeKeywords || requiresTools) {
    taskPhase = "CODE_GENERATION";
    complexityScore = 0.8;
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
