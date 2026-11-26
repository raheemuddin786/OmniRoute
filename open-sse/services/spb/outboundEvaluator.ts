/**
 * SPB-IR Outbound Response Evaluation, Intent-Gap Analysis & Iterative Re-Prompting Engine
 *
 * Responsibilities:
 * 1. Evaluates raw model responses before returning to caller, ensuring 100% satisfaction of original goals.
 * 2. Detects omissions, code truncations, placeholders ("// TODO", "left as an exercise", "rest of code goes here"),
 *    and unaddressed requirements.
 * 3. Formulates precise, targeted re-prompts to iteratively query upstream providers until 0% intention loss is achieved.
 * 4. Buffers streaming tokens in-flight, evaluates satisfaction, and seamlessly streams verified completions to the client.
 * 5. Integrates with SQLite persistence and adaptive self-learning to record satisfaction scores and learned heuristics.
 */

import { TaskPhase, type IntentLedgerItem, type GuidanceContract } from "./intentAnalyzer.ts";
import { ModelTier } from "./tieredRegistry.ts";
import {
  recordIntentEvaluation,
  saveLearnedOptimization,
  getCheckpoint,
  updateGuidanceContract,
  recordSpbTelemetry,
} from "../../../src/lib/db/spbState.ts";
import { computePatternHash } from "./inboundIntelligence.ts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getTierConfig } from "../tierResolver.ts";
import {
  judgeCompletion,
  extractToolEvidenceFromMessages,
  type MechanicalEvidence,
  type ModelDispatchFn,
} from "./apexLedger.ts";
import {
  snapshotWorkingTreeDirtyFiles,
  hasCorruptedToolCalls,
  getNextFailoverTier,
} from "./proxyBridge.ts";

/**
 * Marker injected into stream/json responses when a reviewer discrepancy is unresolved.
 * Prevents downstream turns from treating this system-generated notice as assistant-generated
 * discrepancy evidence, which would otherwise re-trigger the reviewer loop.
 */
export const SPB_REVIEWER_DISCREPANCY_MARKER =
  "[SPB Reviewer Status Check: Factual discrepancy detected]";

/**
 * Resolves the active git working directory for code-diff verification.
 * Prefers the explicit cwd; falls back to detecting an OmniRoute worktree via
 * UPSTREAM_CWD env var; finally falls back to process.cwd().
 */
export function resolveDiffCwd(explicitCwd?: string): string {
  if (explicitCwd && explicitCwd.trim()) return explicitCwd.trim();
  const envCwd = process.env.UPSTREAM_CWD;
  if (envCwd && envCwd.trim()) return envCwd.trim();
  return process.cwd();
}

export interface ResponseEvaluationResult {
  isSatisfied: boolean;
  satisfactionScore: number; // 0.0 to 1.0
  omissions: string[];
  oddities: string[];
  hasCommandDelegation?: boolean;
  claimsExecutionWithoutTools?: boolean;
  hasHallucinatedPaths?: boolean;
  isStagnantAnalysisLoop?: boolean;
  reviewerDiscrepancies?: string[];
  reviewerReport?: string;
  suggestedReprompt?: string;
  repromptCount: number;
}

export interface ExtractedResponseContent {
  text: string;
  isStream: boolean;
  rawChunks: Uint8Array[];
  jsonBody?: Record<string, unknown>;
  hasToolCalls: boolean;
  hasCorruptedToolCalls?: boolean;
  observedToolCalls?: Array<{ name: string; args: string }>;
}

const PLACEHOLDER_PATTERNS = [
  /\bTODO:\s*(?:implement|add|fill|complete)\b/i,
  /\bFIXME\b/i,
  /\b(?:left as an exercise|rest of code remains the same|insert your code here)\b/i,
  /\b(?:code omitted for brevity|remainder of the implementation)\b/i,
  /\/\/\s*\.\.\.\s*(?:rest of code|existing code)/i,
  /\/\*\s*\.\.\.\s*(?:rest of code|existing code)\s*\*\//i,
];

/**
 * Evaluates whether an outbound response satisfies 100% of user intentions and requirements.
 */
export function evaluateResponseIntent(
  originalPrompt: string,
  preservedIntentions: string[],
  responseText: string,
  tier: ModelTier,
  taskPhase: TaskPhase,
  sessionId: string = "default_session",
  hasToolCalls: boolean = false,
  clientHasTools: boolean = false
): ResponseEvaluationResult {
  // If the model produced tool calls, it is an active intermediate turn in an autonomous execution loop.
  // Never flag tool calls as omissions or reprompt them.
  // However, do NOT return 100% satisfaction for intermediate turns - return TURN_IN_PROGRESS status
  if (hasToolCalls) {
    return {
      isSatisfied: false, // Still in progress - do not mark as satisfied
      satisfactionScore: 0.0, // No satisfaction yet for intermediate turns
      omissions: [],
      oddities: [],
      repromptCount: 0,
    };
  }

  // If the original prompt is empty (e.g. tool execution return turn), approve without reprompt
  if (!originalPrompt || !originalPrompt.trim()) {
    return {
      isSatisfied: true,
      satisfactionScore: 1.0,
      omissions: [],
      oddities: [],
      repromptCount: 0,
    };
  }

  const omissions: string[] = [];
  const oddities: string[] = [];
  let score = 1.0;

  const currentConfig = getTierConfig();
  const minResponseLength = currentConfig?.spbConfig?.minResponseLength ?? 20;

  // 1. Detect empty or suspiciously truncated response
  if (!responseText || responseText.trim().length < minResponseLength) {
    omissions.push("Response is empty, severely truncated, or lacks substantive content.");
    score -= 0.6;
  }

  // 1b. Multi-intention coverage verification: check that explicit sub-intentions are not skipped
  // Only enforce execution-specific omissions (like tests/remediation) when the response is expected to be a code mutation turn,
  // not an intermediate conversational, diagnostic, image inspection, or architectural review response.
  const isDiagnosticOrInspectionTurn =
    /\b(what (?:all )?u see|diagnos|investigat|review|audit|explain|inspect)\b/i.test(
      originalPrompt
    ) && !/\b(implement|code|write|patch|apply)\b/i.test(originalPrompt);

  if (
    Array.isArray(preservedIntentions) &&
    preservedIntentions.length > 0 &&
    !isDiagnosticOrInspectionTurn
  ) {
    const unaddressedIntentions: string[] = [];

    for (const intentItem of preservedIntentions) {
      if (typeof intentItem !== "string" || !intentItem.trim()) continue;

      // Check specific domain categories
      if (/\btest/i.test(intentItem)) {
        if (!/\b(test|expect|assert|it\(|describe\(|suite|spec)\b/i.test(responseText)) {
          unaddressedIntentions.push(intentItem);
        }
      } else if (/\b(typescript|type|interface)\b/i.test(intentItem)) {
        if (!/\b(interface|type|:\s*[A-Z][a-zA-Z0-9_<>]+)\b/.test(responseText)) {
          unaddressedIntentions.push(intentItem);
        }
      } else if (/\b(defect|remediation|fix|bug)\b/i.test(intentItem)) {
        if (!/\b(fix|fixed|resolve|resolved|patch|remediat|bug|error)\b/i.test(responseText)) {
          unaddressedIntentions.push(intentItem);
        }
      } else if (/\b(refactor|clean)\b/i.test(intentItem)) {
        if (!/\b(refactor|clean|modular|extract|simplif)\b/i.test(responseText)) {
          unaddressedIntentions.push(intentItem);
        }
      } else if (/\b(architect|plan|structur)\b/i.test(intentItem)) {
        if (!/\b(architect|plan|structur|design|layer|tier|component)\b/i.test(responseText)) {
          unaddressedIntentions.push(intentItem);
        }
      }
    }

    if (unaddressedIntentions.length > 0) {
      omissions.push(
        `Response failed to address ${unaddressedIntentions.length} stated requirement(s): ${unaddressedIntentions.join("; ")}`
      );
      score -= Math.min(0.4, unaddressedIntentions.length * 0.15);
    }
  }

  // 2. Detect lazy placeholders and code omissions
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(responseText)) {
      oddities.push(
        `Detected lazy code placeholder or omitted section matching pattern: ${pattern}`
      );
      score -= 0.25;
    }
  }

  // 3. Verify specific user requests from original prompt
  if (
    /\b(test|spec)\b/i.test(originalPrompt) &&
    !/\b(test|expect|assert|it\(|describe\()\b/i.test(responseText)
  ) {
    omissions.push(
      "User prompt requested tests or specifications, but none were provided in the response."
    );
    score -= 0.2;
  }

  if (
    /\b(typescript|type|interface)\b/i.test(originalPrompt) &&
    !/\b(interface|type|:\s*[A-Z][a-zA-Z0-9_<>]+)\b/.test(responseText)
  ) {
    omissions.push(
      "User requested TypeScript types/interfaces, but no typed constructs were detected."
    );
    score -= 0.15;
  }

  // 4. Detect premature truncation (unclosed markdown code blocks)
  const codeBlockCount = (responseText.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    oddities.push(
      "Response contains an unclosed code block indicating premature truncation or token cutoff."
    );
    score -= 0.3;
  }

  // 5. Detect apologetic or hallucinated refusal fillers
  if (
    /\b(As an AI language model|I cannot access your local files|I am unable to execute or implement|I can(?:not|'t) take on this task|I am unable to fulfill|I'm not able to act on this)\b/i.test(
      responseText
    )
  ) {
    oddities.push("Response contains an apologetic refusal filler instead of required execution.");
    score -= 0.4;
  }

  // 6. Detect conversational stalling / analysis loop when tools are available but unused
  let isStagnantAnalysisLoop = false;
  if (
    clientHasTools &&
    !hasToolCalls &&
    /\b(autonomous|execute|implement|modify|create|build|run|task)\b/i.test(originalPrompt)
  ) {
    if (
      /\b(let me|want me to|should I|let's|I will start by|kick that off)\b/i.test(responseText) &&
      !responseText.includes("```")
    ) {
      oddities.push(
        "Response offered conversational intent without calling tools or providing complete code."
      );
      score -= 0.35;
      isStagnantAnalysisLoop = true;
    }
    // Also detect explicit "Would you like me to proceed?" or permission-seeking
    if (
      /\b(would you like me to|shall i|should i proceed|let me know if|I can proceed|please confirm)\b/i.test(
        responseText
      ) &&
      !hasToolCalls
    ) {
      oddities.push(
        "Response sought user permission for autonomous action instead of executing directly."
      );
      score -= 0.3;
      isStagnantAnalysisLoop = true;
    }
  }

  // 7. Detect command delegation to user when autonomous execution was commanded
  // Patterns that indicate the model is suggesting the user run commands manually
  // instead of executing them autonomously via tools.
  const isAutonomousPrompt =
    /\b(autonomous|execute|run|verify|test|capture|screenshot|implement|build|fix|sdlc|single execution|single prompt)\b/i.test(
      originalPrompt
    );

  const commandDelegationPatterns = [
    // Direct commands telling the user to run in terminal / shell
    /\b(?:you can run|please run|run the following|try running|execute the command|open your terminal and run|run this command)\b/i,
    /\b(?:in your terminal|in the terminal|from the terminal|on your terminal)\b/i,
    // Explicit instructions to execute package manager commands manually
    /\b(?:run|execute)\s+(?:npm|npx|yarn|pnpm|cargo|pytest|mvn|make|bash|vitest|playwright)\b/i,
    // "I cannot execute" followed by suggesting user do it
    /\bI (?:cannot|can not|am unable to) (?:execute|run|run this|take on this task)\b/i,
    // "As an AI" refusal patterns where model deflects execution
    /\bAs an AI (?:language model|I cannot|I'm unable)\b/i,
  ];

  const hasCommandDelegation =
    isAutonomousPrompt &&
    clientHasTools &&
    !hasToolCalls &&
    commandDelegationPatterns.some((pattern) => pattern.test(responseText));

  if (hasCommandDelegation) {
    oddities.push(
      "Response delegates command execution to the user instead of running verification pipeline or capturing evidence autonomously. " +
        "When E2E test runs, screenshot capture, or live verification was commanded, " +
        "the model must execute via tools or report exact tool outputs rather than echoing manual commands back to the user."
    );
    score -= 0.4;
  }

  // 8. Detect false completion claims when execution was requested but no tools were invoked
  let claimsExecutionWithoutTools = false;
  if (
    clientHasTools &&
    !hasToolCalls &&
    /\b(run|execute|capture|screenshot|verify|test)\b/i.test(originalPrompt)
  ) {
    // Only penalize if the user prompt actually demanded tool execution and this is not purely conversational
    const isConversationalIntent =
      /^(?:what|why|how|explain|describe|tell me|review|check|can you explain)\b/i.test(
        originalPrompt.trim()
      );

    if (!isConversationalIntent) {
      claimsExecutionWithoutTools =
        /\b(I have (?:run|executed|captured|verified|tested)|successfully (?:run|executed|captured|verified|tested)|screenshot (?:has been |is )?saved|all tests? passed)\b/i.test(
          responseText
        );
      if (claimsExecutionWithoutTools) {
        oddities.push(
          "Response claimed test execution, screenshot capture, or verification without invoking any execution tools."
        );
        score -= 0.45;
      }
    }
  }

  // 9. Detect hallucinated or placeholder file paths in responses
  // Patterns that suggest the model invented placeholder paths that don't match the repo structure
  // or made claims about files that cannot be verified via tool output.
  const hallucinatedPathPatterns = [
    // Generic placeholder paths commonly hallucinated
    /(?:\/path\/to\/|\/dummy\/|\/fake\/|\[insert path\]|<path-to-|<file-path>)/i,
    /\b[A-Za-z]:\/(?:path|dummy|fake)\//i,
  ];

  const hasHallucinatedPaths = hallucinatedPathPatterns.some((pattern) =>
    pattern.test(responseText)
  );

  if (hasHallucinatedPaths) {
    oddities.push(
      "Response contains hallucinated or non-existent file paths. " +
        "All file paths referenced in completions must be verifiable via repo structure or tool output. " +
        "Never invent paths; if a path cannot be confirmed, report that verification is required rather than hallucinating."
    );
    score -= 0.35;
  }

  // Clamp score
  score = Math.max(0.0, Math.min(1.0, score));
  const isSatisfied = score >= 0.85 && omissions.length === 0 && oddities.length === 0;

  let suggestedReprompt: string | undefined;
  if (!isSatisfied) {
    const missingDetails = [...omissions, ...oddities].join("; ");
    suggestedReprompt = `Your previous response was incomplete or contained omissions: ${missingDetails}. Please supply the complete, production-grade implementation fulfilling all requirements with strictly zero placeholders, zero truncations, and 100% complete code.`;
  }

  // Record evaluation telemetry
  const patternHash = computePatternHash(originalPrompt, taskPhase);
  try {
    recordIntentEvaluation({
      sessionId,
      promptAnchorHash: patternHash,
      tier,
      taskPhase,
      satisfactionScore: score,
      detectedOmissions: JSON.stringify([...omissions, ...oddities]),
      repromptCount: isSatisfied ? 0 : 1,
      repromptSuccess: isSatisfied,
      evaluatedAt: Date.now(),
    });

    // Update adaptive learning knowledge
    saveLearnedOptimization({
      patternHash,
      tier,
      taskPhase,
      optimizationStrategy: isSatisfied ? "zero_loss_direct" : "iterative_reprompt_recovery",
      enhancementTemplate: suggestedReprompt || "standard_enhancement",
      successCount: isSatisfied ? 1 : 0,
      failureCount: isSatisfied ? 0 : 1,
      avgSatisfactionScore: score,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  } catch (_err) {
    // Non-fatal telemetry catch
  }

  return {
    isSatisfied,
    satisfactionScore: score,
    omissions,
    oddities,
    hasCommandDelegation,
    claimsExecutionWithoutTools,
    hasHallucinatedPaths,
    isStagnantAnalysisLoop,
    suggestedReprompt,
    repromptCount: isSatisfied ? 0 : 1,
  };
}

export interface CodeDiffReviewResult {
  passed: boolean;
  actualModifiedFiles: string[];
  claimedFilesMissingInDiff: string[];
  report?: string;
}

/**
 * Extracts file paths claimed to be created, modified, or updated from completion text.
 */
export function extractClaimedFilesFromText(text: string): string[] {
  const found = new Set<string>();

  // 1. Markdown link targets: [filename.ts](path/to/filename.ts)
  const mdLinkRegex = /\[([^\]]+)\]\(([^)]+\.[a-zA-Z0-9]+)(?:#L\d+(?:-L\d+)?)?\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdLinkRegex.exec(text)) !== null) {
    const rawPath = match[2].trim().replace(/^(\.\/|\/)/, "");
    if (!rawPath.startsWith("http://") && !rawPath.startsWith("https://")) {
      found.add(rawPath);
    }
  }

  // 2. Explicit paths in backticks: `src/foo/bar.ts` or `open-sse/...`
  const backtickRegex = /`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]{1,10})`/g;
  while ((match = backtickRegex.exec(text)) !== null) {
    const rawPath = match[1].trim().replace(/^(\.\/|\/)/, "");
    if (rawPath.includes("/") && !rawPath.includes(" ")) {
      found.add(rawPath);
    }
  }

  // 3. Sentences explicitly claiming edits/creations:
  const verbRegex =
    /\b(?:created|modified|updated|edited|patched|wrote)\s+([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]{1,10})\b/gi;
  while ((match = verbRegex.exec(text)) !== null) {
    const rawPath = match[1].trim().replace(/^(\.\/|\/)/, "");
    if (rawPath.includes("/")) {
      found.add(rawPath);
    }
  }

  return Array.from(found);
}

/**
 * Conclusion Reviewer: Factual Verification against Repository Code Diff.
 * Checks whether the agent's claimed code modifications actually exist in git diff/status.
 * If discrepancies exist, generates a structured Reviewer Report so the agent can reiterate.
 */
export function verifyCodeDiffAgainstConclusion(
  conclusionText: string,
  _cwd?: string
): CodeDiffReviewResult {
  const cwd = resolveDiffCwd(_cwd);
  const currentConfig = getTierConfig();
  const diffTimeoutMs = currentConfig?.spbConfig?.diffTimeoutMs ?? 5000;
  try {
    const diffProc = spawnSync("git", ["diff", "--name-only", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: diffTimeoutMs,
    });
    const statusProc = spawnSync("git", ["status", "--porcelain=v1", "-uall"], {
      cwd,
      encoding: "utf8",
      timeout: diffTimeoutMs,
    });

    if (diffProc.status !== 0 && statusProc.status !== 0) {
      return { passed: true, actualModifiedFiles: [], claimedFilesMissingInDiff: [] };
    }

    const actualFiles = new Set<string>();
    if (diffProc.stdout) {
      for (const line of diffProc.stdout.split("\n")) {
        const file = line.trim();
        if (file) actualFiles.add(file);
      }
    }
    if (statusProc.stdout) {
      for (const line of statusProc.stdout.split("\n")) {
        const lineTrimmed = line.trim();
        if (lineTrimmed) {
          const file = lineTrimmed.slice(3).trim();
          if (file.includes("->")) {
            const parts = file.split("->").map((p) => p.trim());
            for (const p of parts) {
              if (p) actualFiles.add(p);
            }
          } else if (file) {
            actualFiles.add(file);
          }
        }
      }
    }

    const actualModifiedFiles = Array.from(actualFiles);
    const claimedFiles = extractClaimedFilesFromText(conclusionText);

    const claimedFilesMissingInDiff: string[] = [];
    for (const claimed of claimedFiles) {
      const matched = actualModifiedFiles.some(
        (actual) =>
          actual === claimed || actual.endsWith("/" + claimed) || claimed.endsWith("/" + actual)
      );
      if (!matched) {
        claimedFilesMissingInDiff.push(claimed);
      }
    }

    const claimsCompletionWithoutAnyDiff =
      actualModifiedFiles.length === 0 &&
      claimedFiles.length > 0 &&
      /\b(I have (?:implemented|applied|modified|updated|created|fixed|resolved)|changes (?:are|have been) (?:applied|made|committed)|(?:resolved|fixed|implemented|updated|verified)\s*&\s*verified|tests?\s*(?:passed|verified)|deployed?\s*(?:successfully|cleanly))\b/i.test(
        conclusionText
      );

    if (claimedFilesMissingInDiff.length > 0 || claimsCompletionWithoutAnyDiff) {
      const missingList =
        claimedFilesMissingInDiff.length > 0
          ? claimedFilesMissingInDiff.map((f) => `  - ${f}`).join("\n")
          : "  - (Claimed implementation completed, but git diff shows 0 modified or created files)";

      const actualList =
        actualModifiedFiles.length > 0
          ? actualModifiedFiles.map((f) => `  - ${f}`).join("\n")
          : "  - (none)";

      const report =
        `[REVIEWER FACTUAL VERIFICATION REPORT]\n` +
        `Factual discrepancy detected: Your conclusion claims code modifications were completed, but repository code diff verification failed:\n` +
        `Claimed files missing from actual code diff:\n${missingList}\n` +
        `Actual modified files on disk:\n${actualList}\n\n` +
        `INSTRUCTION: Reiterate and apply the required modifications using your file editing tools (Write/Edit/Bash). ` +
        `Do not conclude until the required code modifications are physically written and verified on disk.`;

      return {
        passed: false,
        actualModifiedFiles,
        claimedFilesMissingInDiff,
        report,
      };
    }

    return {
      passed: true,
      actualModifiedFiles,
      claimedFilesMissingInDiff: [],
    };
  } catch (err) {
    console.error("[SPB Reviewer] Git diff verification failed to execute:", err);
    // Fail-open: when verification cannot execute, do not block autonomous agents
    return { passed: true, actualModifiedFiles: [], claimedFilesMissingInDiff: [] };
  }
}

/**
 * Extracts raw textual content from either an SSE stream or a JSON response.
 */
export async function extractResponseContent(
  response: Response
): Promise<ExtractedResponseContent> {
  const contentType = response.headers.get("content-type") || "";
  const isStream =
    contentType.includes("text/event-stream") || !contentType.includes("application/json");

  if (!isStream) {
    try {
      const clone = response.clone();
      const json = (await clone.json()) as Record<string, unknown>;
      let text = "";
      let hasToolCalls = false;
      const observedToolCalls: Array<{ name: string; args: string }> = [];
      const choices = json?.choices as Array<Record<string, unknown>> | undefined;
      const firstChoiceMsg = choices?.[0]?.message as Record<string, unknown> | undefined;
      if (typeof firstChoiceMsg?.content === "string") {
        text = firstChoiceMsg.content;
      } else if (Array.isArray(json?.content)) {
        text = (json.content as Array<Record<string, unknown>>)
          .map((c) => (typeof c.text === "string" ? c.text : ""))
          .join(" ");
      } else if (Array.isArray(json?.candidates)) {
        const candidates = json.candidates as Array<Record<string, unknown>>;
        const contentObj = candidates?.[0]?.content as Record<string, unknown> | undefined;
        const parts = contentObj?.parts as Array<Record<string, unknown>> | undefined;
        if (typeof parts?.[0]?.text === "string") {
          text = parts[0].text;
        }
      }

      // Detect tool calls in JSON
      let isToolCallsCorrupted = false;
      if (Array.isArray(firstChoiceMsg?.tool_calls) && firstChoiceMsg.tool_calls.length > 0) {
        if (hasCorruptedToolCalls(json)) {
          isToolCallsCorrupted = true;
        }
        hasToolCalls = !isToolCallsCorrupted;
        for (const tc of firstChoiceMsg.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn && (fn.arguments === "" || fn.arguments === undefined)) {
            fn.arguments = "{}";
          }
          if (fn?.name) {
            observedToolCalls.push({
              name: String(fn.name),
              args:
                typeof fn.arguments === "string"
                  ? fn.arguments
                  : JSON.stringify(fn.arguments || {}),
            });
          }
        }
      }
      if (choices?.[0]?.finish_reason === "tool_calls" && !isToolCallsCorrupted) {
        hasToolCalls = true;
      }
      if (Array.isArray(json?.content)) {
        for (const c of json.content as Array<Record<string, unknown>>) {
          if (c && typeof c === "object" && (c.type === "tool_use" || c.type === "tool_call")) {
            hasToolCalls = true;
            observedToolCalls.push({
              name: typeof c.name === "string" ? c.name : "",
              args: typeof c.input === "string" ? c.input : JSON.stringify(c.input || {}),
            });
          }
        }
      }
      if (json?.stop_reason === "tool_use") {
        hasToolCalls = true;
      }
      if (Array.isArray(json?.candidates)) {
        const candidate = json.candidates[0] as Record<string, unknown> | undefined;
        const candidateContent = candidate?.content as Record<string, unknown> | undefined;
        const parts = candidateContent?.parts as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p && typeof p === "object" && p.functionCall) {
              hasToolCalls = true;
              const fc = p.functionCall as Record<string, unknown>;
              observedToolCalls.push({
                name: typeof fc.name === "string" ? fc.name : "",
                args: typeof fc.args === "string" ? fc.args : JSON.stringify(fc.args || {}),
              });
            }
          }
        }
      }

      return {
        text,
        isStream: false,
        rawChunks: [],
        jsonBody: json,
        hasToolCalls,
        hasCorruptedToolCalls: isToolCallsCorrupted,
        observedToolCalls,
      };
    } catch {
      return {
        text: "",
        isStream: false,
        rawChunks: [],
        hasToolCalls: false,
        observedToolCalls: [],
      };
    }
  }

  // Streaming extraction: consume and buffer stream chunks
  const rawChunks: Uint8Array[] = [];
  const observedToolCalls: Array<{ name: string; args: string }> = [];
  let accumulatedText = "";
  let hasToolCalls = false;
  const decoder = new TextDecoder();

  if (response.body) {
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          rawChunks.push(value);
          const chunkStr = decoder.decode(value, { stream: true });
          const lines = chunkStr.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice("data:".length).trim();
            if (dataStr === "[DONE]") continue;
            try {
              const parsed = JSON.parse(dataStr);
              // OpenAI delta
              if (parsed.choices?.[0]?.delta?.content) {
                accumulatedText += parsed.choices[0].delta.content;
              }
              // Anthropic delta (text and extended thinking)
              else if (
                parsed.type === "content_block_delta" &&
                (parsed.delta?.text || parsed.delta?.thinking)
              ) {
                const deltaPiece = parsed.delta.text || parsed.delta.thinking || "";
                accumulatedText += deltaPiece;
                // Repetition circuit breaker: detect degenerate loops in thinking or content
                if (accumulatedText.length > 200) {
                  const tail = accumulatedText.slice(-300);
                  const lines = tail
                    .split(/\r?\n/)
                    .map((l) => l.trim())
                    .filter((l) => l.length >= 15);
                  if (lines.length >= 5) {
                    const lastLine = lines[lines.length - 1];
                    const matches = lines.filter((l) => l === lastLine);
                    if (matches.length >= 5) {
                      console.warn(
                        `[SPB Outbound] Degenerative repetition circuit breaker tripped on: "${lastLine.slice(0, 40)}...". Aborting runaway stream.`
                      );
                      await reader.cancel();
                      break;
                    }
                  }
                }
              }
              // Gemini candidate
              else if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
                accumulatedText += parsed.candidates[0].content.parts[0].text;
              }

              // OpenAI tool calls
              if (
                (Array.isArray(parsed.choices?.[0]?.delta?.tool_calls) &&
                  parsed.choices[0].delta.tool_calls.length > 0) ||
                parsed.choices?.[0]?.finish_reason === "tool_calls"
              ) {
                hasToolCalls = true;
                if (Array.isArray(parsed.choices?.[0]?.delta?.tool_calls)) {
                  for (const tc of parsed.choices[0].delta.tool_calls) {
                    if (tc.function?.name || tc.function?.arguments) {
                      observedToolCalls.push({
                        name: tc.function.name || "",
                        args: tc.function.arguments || "",
                      });
                    }
                  }
                }
              }
              // Anthropic tool_use
              else if (
                (parsed.type === "content_block_start" &&
                  parsed.content_block?.type === "tool_use") ||
                (parsed.type === "message_delta" && parsed.delta?.stop_reason === "tool_use") ||
                parsed.type === "tool_use"
              ) {
                hasToolCalls = true;
                if (parsed.content_block?.name) {
                  observedToolCalls.push({
                    name: parsed.content_block.name,
                    args: JSON.stringify(parsed.content_block.input || {}),
                  });
                }
              }
              // Gemini functionCall
              else if (parsed.candidates?.[0]?.content?.parts?.[0]?.functionCall) {
                hasToolCalls = true;
                const fc = parsed.candidates[0].content.parts[0].functionCall;
                observedToolCalls.push({
                  name: fc.name || "",
                  args: JSON.stringify(fc.args || {}),
                });
              }
            } catch {
              // Non-JSON frame
            }
          }
        }
      }
    } catch (streamErr: unknown) {
      const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      console.warn(
        `[SPB Outbound ZeroLoss] Stream reading interrupted or aborted (${errMsg}). Preserving ${rawChunks.length} accumulated chunks.`
      );
    }
  }

  if (!hasToolCalls && rawChunks.length > 0) {
    const fullPayload = decoder.decode(Buffer.concat(rawChunks));
    if (
      fullPayload.includes('"type":"tool_use"') ||
      fullPayload.includes('"tool_use"') ||
      fullPayload.includes('"tool_calls"') ||
      fullPayload.includes('"finish_reason":"tool_calls"') ||
      fullPayload.includes('"stop_reason":"tool_use"') ||
      fullPayload.includes('"functionCall"')
    ) {
      hasToolCalls = true;
    }
  }

  let streamCorruptedToolCalls = false;
  if (observedToolCalls.length > 0) {
    for (const tc of observedToolCalls) {
      if (tc.name && tc.name.trim().length > 0) {
        if (tc.args === "" || tc.args === null || tc.args === undefined) {
          streamCorruptedToolCalls = true;
          break;
        }
        const trimmed = typeof tc.args === "string" ? tc.args.trim() : "";
        if (trimmed === "") {
          streamCorruptedToolCalls = true;
          break;
        }
        if (
          (trimmed.startsWith("{") && !trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && !trimmed.endsWith("]"))
        ) {
          streamCorruptedToolCalls = true;
          break;
        }
        try {
          JSON.parse(trimmed);
        } catch {
          streamCorruptedToolCalls = true;
          break;
        }
      }
    }
  }

  if (streamCorruptedToolCalls) {
    hasToolCalls = false;
  }

  return {
    text: accumulatedText,
    isStream: true,
    rawChunks,
    hasToolCalls,
    hasCorruptedToolCalls: streamCorruptedToolCalls,
    observedToolCalls,
  };
}

export function pruneOldToolOutputsForReprompt(
  messages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  // Keep the most recent 2 tool outputs intact, truncate older historical tool outputs to 500 chars to conserve tokens
  let toolCount = 0;
  const reversed = [...messages].reverse();
  const prunedReversed = reversed.map((msg) => {
    if (
      msg.role === "tool" ||
      (typeof msg.content === "string" && msg.content.includes("tool_result"))
    ) {
      toolCount++;
      if (toolCount > 2 && typeof msg.content === "string" && msg.content.length > 500) {
        return {
          ...msg,
          content: msg.content.slice(0, 500) + "... [truncated for token conservation]",
        };
      }
    }
    return msg;
  });
  return prunedReversed.reverse();
}

/**
 * Reconstructs a streaming Response from buffered rawChunks, attaching SPB audit headers.
 */
export function reconstructStreamResponse(
  rawChunks: Uint8Array[],
  originalResponse: Response,
  evalResult: ResponseEvaluationResult,
  repromptCount: number,
  ledgerSummary?: string
): Response {
  const headers = new Headers(originalResponse.headers);
  headers.set("X-OmniRoute-SPB-Satisfaction", evalResult.satisfactionScore.toFixed(2));
  headers.set("X-OmniRoute-SPB-Reprompt-Count", String(repromptCount));
  headers.set("X-OmniRoute-SPB-ZeroLoss", evalResult.isSatisfied ? "verified" : "partial");
  if (ledgerSummary) {
    headers.set("X-OmniRoute-SPB-Ledger-Summary", "included");
  }
  if (evalResult.reviewerReport) {
    headers.set(
      "X-OmniRoute-Reviewer-Status",
      evalResult.isSatisfied
        ? "verified"
        : repromptCount >= 2
          ? "discrepancy-unresolved"
          : "reprompted"
    );
  } else {
    headers.set("X-OmniRoute-Reviewer-Status", "verified");
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let isAnthropic = false;
      let hasDoneMarker = false;

      for (const chunk of rawChunks) {
        const text = decoder.decode(chunk, { stream: true });
        if (text.includes("event: content_block_delta") || text.includes("message_delta")) {
          isAnthropic = true;
        }
        if (text.includes("data: [DONE]")) {
          hasDoneMarker = true;
          // Strip [DONE] from this chunk to enqueue summary before it
          const stripped = text.replace(/data:\s*\[DONE\]\s*\n*/g, "");
          if (stripped.trim()) {
            controller.enqueue(encoder.encode(stripped));
          }
          continue;
        }
        controller.enqueue(chunk);
      }

      if (ledgerSummary) {
        if (isAnthropic) {
          const escaped = ledgerSummary
            .replace(/\\/g, "\\\\")
            .replace(/\n/g, "\\n")
            .replace(/"/g, '\\"');
          const anthropicEvent =
            `event: content_block_delta\n` +
            `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\\n\\n${escaped}"}}\n\n`;
          controller.enqueue(encoder.encode(anthropicEvent));
        } else {
          const escaped = ledgerSummary
            .replace(/\\/g, "\\\\")
            .replace(/\n/g, "\\n")
            .replace(/"/g, '\\"');
          const openAiEvent = `data: {"choices":[{"delta":{"content":"\\n\\n${escaped}"}}]}\n\n`;
          controller.enqueue(encoder.encode(openAiEvent));
        }
      }

      if (hasDoneMarker) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
      // Header-only reviewer signaling — do NOT append the discrepancy notice into assistant
      // stream content, otherwise the agent's next turn reads its own warning as assistant output
      // and re-triggers the reviewer loop forever.
      controller.close();
    },
  });

  return new Response(stream, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers,
  });
}

/**
 * Observes mutating and execution tool calls across turns, updating the Intent Ledger
 * in SQLite checkpoint and enforcing the Scope Fence.
 */
export function observeToolCallsOnLedger(
  sessionId: string,
  extracted: ExtractedResponseContent
): { updatedCount: number; violations: string[] } {
  try {
    const checkpoint = getCheckpoint(sessionId);
    const contract = checkpoint?.guidanceContract as GuidanceContract | undefined;
    if (!contract || !Array.isArray(contract.intents) || contract.intents.length === 0) {
      return { updatedCount: 0, violations: [] };
    }

    const observed = extracted.observedToolCalls || [];
    let updatedCount = 0;
    const violations: string[] = [];

    // Parse gap declarations from intermediate turn text (e.g. "[I1: exists]" or "[I2: missing]")
    if (extracted.text) {
      for (const item of contract.intents) {
        if (item.status === "done" || item.status === "blocked") continue;
        const gapMatch = extracted.text.match(
          new RegExp(`(?:\\[?${item.id}\\]?|${item.id})\\s*[:=-]\\s*(exists|partial|missing)`, "i")
        );
        if (gapMatch) {
          const declaredGap = gapMatch[1].toLowerCase();
          item.gap = declaredGap as "exists" | "partial" | "missing";
          if (declaredGap === "exists") {
            const lineText =
              gapMatch[0] +
              (extracted.text.slice(gapMatch.index! + gapMatch[0].length).split("\n")[0] || "");
            const citedInLine = (
              lineText.match(/(?:[\w\-\.\/]+\.(?:ts|tsx|js|jsx|json|sql|md|py|go|rs))/gi) || []
            ).map((f) => f.replace(/^(\.\/|\/)/, ""));
            const candidateFiles = Array.from(
              new Set([...(item.targetFiles || []), ...citedInLine])
            );

            const readFiles = contract.observedReadFiles || [];
            // Strictly require that the cited file was read in this session
            const hasCitedRead =
              candidateFiles.length > 0 &&
              readFiles.some((rf) =>
                candidateFiles.some((tf) => rf.endsWith(tf) || tf.endsWith(rf) || rf === tf)
              );

            if (hasCitedRead) {
              item.status = "done_unverified";
              item.evidence = `Verified existing via gap inspection of ${candidateFiles.join(", ")}`;
              updatedCount++;
            }
          } else if (declaredGap === "missing") {
            if (item.status !== "open") {
              item.status = "open";
              updatedCount++;
            }
          }
        }
      }
    }

    for (const tc of observed) {
      const toolName = tc.name || "";
      const argsStr = tc.args || "";

      let touchedPath: string | undefined;
      let isTestCommand = false;
      let isShellMutation = false;
      let shellMutationDesc: string | undefined;

      // Extract file path safely from JSON or regex
      let cmd: string | undefined;
      try {
        const parsedArgs = typeof argsStr === "string" ? JSON.parse(argsStr) : argsStr;
        if (parsedArgs && typeof parsedArgs === "object") {
          touchedPath =
            parsedArgs.file_path ||
            parsedArgs.filePath ||
            parsedArgs.path ||
            parsedArgs.filename ||
            parsedArgs.target;
          cmd = parsedArgs.command || parsedArgs.cmd || parsedArgs.CommandLine;
        }
      } catch {
        const pathMatch = argsStr.match(
          /"(?:path|file_path|filePath|filename|file|target)"\s*:\s*"([^"]+)"/i
        );
        if (pathMatch) {
          touchedPath = pathMatch[1].trim();
        }
        const cmdMatch = argsStr.match(/"(?:command|cmd|CommandLine)"\s*:\s*"([^"]+)"/i);
        if (cmdMatch) {
          cmd = cmdMatch[1].trim();
        }
      }

      // Check command
      if (cmd) {
        const trimmedCmd = cmd.trim();
        const isStrictTestRunner =
          /\b(?:npm\s+test|npm\s+run\s+test|npx\s+(?:jest|vitest|mocha)|pytest|cargo\s+test|go\s+test)\b/i.test(
            trimmedCmd
          );
        if (isStrictTestRunner) {
          isTestCommand = true;
        }

        // Check for shell mutation commands (redirection, sed -i, tee, cat >, touch, cp)
        // Redirection must NOT be preceded by &, =, <, or - (e.g. 2>&1, =>, <=, ->)
        const redirMatch = trimmedCmd.match(
          /(?:^|[^&=<-])(?:\s+)(?:>>|>)\s*([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/
        );
        const sedMatch = trimmedCmd.match(
          /\bsed\s+(?:-[a-zA-Z0-9_]+\s+)*-i(?:\s*['"]\s*['"]|\s+['"][^'"]*['"]|\b)\s*.*?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/
        );
        const teeMatch = trimmedCmd.match(/\btee\s+(?:-a\s+)?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/);
        const catMatch = trimmedCmd.match(
          /\bcat\s+(?:<<\s*['"]?[A-Z0-9_]+['"]?\s*)?>\s*([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/
        );
        const touchMatch = trimmedCmd.match(/\btouch\s+([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/);
        const cpMatch = trimmedCmd.match(
          /\bcp\s+(?:-[a-zA-Z]+\s+)*[^\s]+\s+([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/
        );

        const candidateCmdFile =
          redirMatch?.[1] ||
          sedMatch?.[1] ||
          teeMatch?.[1] ||
          catMatch?.[1] ||
          touchMatch?.[1] ||
          cpMatch?.[1];

        if (candidateCmdFile) {
          const lower = candidateCmdFile.toLowerCase();
          const cwd = resolveDiffCwd();
          const resolved = path.isAbsolute(candidateCmdFile)
            ? candidateCmdFile
            : path.resolve(cwd, candidateCmdFile);
          const isDevOrTmp =
            lower.startsWith("/dev/") ||
            lower.includes("/dev/null") ||
            lower.startsWith("/tmp/") ||
            /(?:^|\/)tmp(?:$|\/)/i.test(candidateCmdFile);
          const isInsideWorkspace = resolved.startsWith(cwd);
          const hasProjectExt =
            /\.(?:ts|tsx|js|jsx|json|sql|prisma|html|css|py|go|rs|md|ya?ml|env)$/i.test(
              candidateCmdFile
            );

          if (!isDevOrTmp && isInsideWorkspace && hasProjectExt) {
            isShellMutation = true;
            touchedPath = candidateCmdFile;
            shellMutationDesc = `shell command '${trimmedCmd.slice(0, 40)}'`;
          }
        } else if (
          /\b(?:prisma\s+migrate|drizzle-kit|typeorm\s+migration|knex\s+migrate)\b/i.test(
            trimmedCmd
          )
        ) {
          isShellMutation = true;
          shellMutationDesc = `database migration tool`;
        }
      }

      const isReadTool =
        /^(?:Read|read_file|Grep|grep|Glob|glob|cat|view_file|list_directory|ls)$/i.test(toolName);
      const isMutatingTool =
        (/^(?:Edit|Write|create_file|edit_file|write_file|apply_diff|str_replace_editor|patch_file)$/i.test(
          toolName
        ) &&
          !isReadTool) ||
        isShellMutation;

      if (touchedPath) {
        if (isReadTool) {
          contract.observedReadFiles = Array.from(
            new Set([...(contract.observedReadFiles || []), touchedPath])
          );
        } else if (isMutatingTool) {
          let matched = false;
          // 1. Try targetFiles exact match first
          for (const item of contract.intents) {
            const files = item.targetFiles || [];
            if (files.some((f) => touchedPath!.endsWith(f) || f.endsWith(touchedPath!))) {
              matched = true;
              if (item.status === "open") {
                item.status = "in_progress";
                item.evidence = `Touched ${touchedPath} via ${shellMutationDesc || toolName}`;
                updatedCount++;
              }
              break;
            }
          }

          // 2. If no targetFiles match, match the first open item in that layer
          if (!matched) {
            for (const item of contract.intents) {
              const matchesLayer =
                (item.layer === "api" && /(?:api|route|server|controller)/i.test(touchedPath!)) ||
                (item.layer === "ui" && /(?:components?|pages?|views?|ui)/i.test(touchedPath!)) ||
                (item.layer === "data" &&
                  /(?:db|migrations?|schema|models?|sql)/i.test(touchedPath!)) ||
                (item.layer === "test" && /(?:tests?|specs?|__tests?__)/i.test(touchedPath!));

              if (matchesLayer && item.status === "open") {
                matched = true;
                item.status = "in_progress";
                item.evidence = `Touched ${touchedPath} via ${shellMutationDesc || toolName}`;
                updatedCount++;
                break; // Attribute to single best item only!
              }
            }
          }

          // Scope fence check (exempt .github/ while excluding .git/ internal)
          const isGitInternal = /(?:^|\/)\.git(?:\/|$)/.test(touchedPath);
          if (
            !matched &&
            !touchedPath.includes("tmp") &&
            !isGitInternal &&
            !touchedPath.includes("node_modules")
          ) {
            violations.push(touchedPath);
          }
        }
      }

      if (!touchedPath && isShellMutation && shellMutationDesc?.includes("migration")) {
        for (const item of contract.intents) {
          if (item.layer === "data" && item.status === "open") {
            item.status = "in_progress";
            item.evidence = "Executed database migration tool";
            updatedCount++;
            break;
          }
        }
      }

      if (isTestCommand) {
        for (const item of contract.intents) {
          if (item.layer === "test" && item.status === "open") {
            item.status = "in_progress";
            item.evidence = "Executed test command";
            updatedCount++;
            break; // Attribute to first open test item only!
          }
        }
      }
    }

    if (violations.length > 0) {
      contract.outOfScopeViolations = Array.from(
        new Set([...(contract.outOfScopeViolations || []), ...violations])
      );
    }

    if (updatedCount > 0 || violations.length > 0) {
      updateGuidanceContract(sessionId, contract);
    }

    return { updatedCount, violations };
  } catch (err) {
    console.warn("[SPB Outbound] Error observing tool calls on ledger:", err);
    return { updatedCount: 0, violations: [] };
  }
}

export interface LedgerEvaluationResult {
  isSatisfied: boolean;
  openItems: IntentLedgerItem[];
  doneItems: IntentLedgerItem[];
  suggestedReprompt?: string;
  isBlocked?: boolean;
}

export function buildLedgerSummaryReport(intents: IntentLedgerItem[]): string {
  const lines = ["[SPB Intent Ledger Summary]"];
  for (const item of intents) {
    const statusDesc =
      item.status === "done"
        ? "Completed"
        : item.status === "done_unverified"
          ? "Completed (unverified / remote client)"
          : item.status === "blocked"
            ? `Blocked / Incomplete: ${item.evidence || "No progress"}`
            : `Incomplete (${item.status})`;
    lines.push(
      `- [${item.id}] (${item.layer.toUpperCase()}) [${item.kind}]: ${item.text} -> ${statusDesc}`
    );
  }
  return lines.join("\n");
}

/**
 * Evaluates completion of each Intent Ledger item against code diffs and execution evidence.
 * Blocks final turn completion until all required items are fulfilled.
 */
export function evaluateLedgerCompletion(
  sessionId: string,
  conclusionText: string,
  diffReview: CodeDiffReviewResult | null,
  strictCompletion: boolean = true
): LedgerEvaluationResult {
  const checkpoint = getCheckpoint(sessionId);
  const contract = checkpoint?.guidanceContract as GuidanceContract | undefined;
  if (!contract || !Array.isArray(contract.intents) || contract.intents.length === 0) {
    return { isSatisfied: true, openItems: [], doneItems: [] };
  }

  // Filter out pre-existing dirty files recorded at session start, unless content hash changed
  const baselineFiles = contract.baselineModifiedFiles || [];
  const baselineHashes = contract.baselineFileHashes || {};
  const baselineStats = contract.baselineFileStats || {};
  const cwd = resolveDiffCwd();

  const newlyModifiedFiles: string[] = [];
  for (const f of diffReview?.actualModifiedFiles || []) {
    if (!baselineFiles.includes(f)) {
      newlyModifiedFiles.push(f);
    } else {
      const baseHash = baselineHashes[f];
      const baseStat = baselineStats[f];
      if (baseHash) {
        try {
          const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
          if (fs.existsSync(abs)) {
            const st = fs.statSync(abs);
            if (st.isFile()) {
              // Fast path: if size and mtime are unchanged, file wasn't written to!
              if (baseStat && st.size === baseStat.size && st.mtimeMs <= baseStat.mtime) {
                continue;
              }
              let currentHash = "";
              if (st.size <= 2 * 1024 * 1024) {
                currentHash = crypto
                  .createHash("sha256")
                  .update(fs.readFileSync(abs))
                  .digest("hex");
              } else {
                const fd = fs.openSync(abs, "r");
                const buf = Buffer.alloc(64 * 1024);
                const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
                fs.closeSync(fd);
                currentHash = crypto
                  .createHash("sha256")
                  .update(`${st.size}:${st.mtimeMs}:`)
                  .update(buf.subarray(0, bytesRead))
                  .digest("hex");
              }
              if (currentHash !== baseHash) {
                // File was dirty at session start, but modified further during this session!
                newlyModifiedFiles.push(f);
              }
            }
          }
        } catch {
          // Non-blocking fallback
        }
      }
    }
  }

  const consumedFiles = new Set<string>();

  for (const item of contract.intents) {
    if (item.status === "done" || item.status === "blocked") continue;

    // 0. Parse gap declarations from the agent (e.g. "[I1: exists]" or "I1: exists")
    const gapMatch = conclusionText.match(
      new RegExp(`(?:\\[?${item.id}\\]?|${item.id})\\s*[:=-]\\s*(exists|partial|missing)`, "i")
    );
    if (gapMatch) {
      const declaredGap = gapMatch[1].toLowerCase();
      item.gap = declaredGap as "exists" | "partial" | "missing";
      if (declaredGap === "exists") {
        const lineText =
          gapMatch[0] +
          (conclusionText.slice(gapMatch.index! + gapMatch[0].length).split("\n")[0] || "");
        const citedInLine = (
          lineText.match(/(?:[\w\-\.\/]+\.(?:ts|tsx|js|jsx|json|sql|md|py|go|rs))/gi) || []
        ).map((f) => f.replace(/^(\.\/|\/)/, ""));
        const candidateFiles = Array.from(new Set([...(item.targetFiles || []), ...citedInLine]));

        const readFiles = contract.observedReadFiles || [];
        // Strictly require that the cited file was read in this session
        const hasCitedRead =
          candidateFiles.length > 0 &&
          readFiles.some((rf) =>
            candidateFiles.some((tf) => rf.endsWith(tf) || tf.endsWith(rf) || rf === tf)
          );

        if (hasCitedRead) {
          item.status = "done_unverified";
          item.evidence = `Verified existing via gap inspection of ${candidateFiles.join(", ")}`;
          continue;
        }
      }
      if (declaredGap === "missing") {
        item.status = "open";
        continue;
      }
    }

    // 1. Evidence via physical git diff of NEWLY modified files
    if (newlyModifiedFiles.length > 0) {
      const unconsumed = newlyModifiedFiles.filter((f) => !consumedFiles.has(f));
      // Try targetFiles first
      const targetMatch = unconsumed.find((mf) =>
        (item.targetFiles || []).some((tf) => mf.endsWith(tf) || tf.endsWith(mf))
      );
      if (targetMatch) {
        if (item.layer === "test") {
          const requiresExecution =
            Boolean(contract.requireTestPassBeforeDone) ||
            item.acceptance?.toLowerCase().includes("pass") ||
            item.acceptance?.toLowerCase().includes("execute");
          const hasExecutedTest =
            Boolean(contract.testExecutionPassed) ||
            Boolean(item.evidence?.includes("Executed test command"));

          if (requiresExecution && !hasExecutedTest) {
            item.status = "in_progress";
            item.evidence = `Modified test file in git diff: ${targetMatch}. Pending test execution.`;
            consumedFiles.add(targetMatch);
            continue;
          }
        }
        item.status = "done";
        item.evidence = `Verified newly modified file in git diff: ${targetMatch}`;
        consumedFiles.add(targetMatch);
        continue;
      }

      // Try layer match, attributing to this single item only
      const layerMatch = unconsumed.find((f) => {
        if (item.layer === "api") return /(?:api|route|server|controller)/i.test(f);
        if (item.layer === "ui") return /(?:components?|pages?|views?|ui)/i.test(f);
        if (item.layer === "data") return /(?:db|migrations?|schema|models?|sql)/i.test(f);
        if (item.layer === "test") return /(?:tests?|specs?|__tests?__)/i.test(f);
        return false;
      });

      if (layerMatch) {
        if (item.layer === "test") {
          const requiresExecution =
            Boolean(contract.requireTestPassBeforeDone) ||
            item.acceptance?.toLowerCase().includes("pass") ||
            item.acceptance?.toLowerCase().includes("execute");
          const hasExecutedTest =
            Boolean(contract.testExecutionPassed) ||
            Boolean(item.evidence?.includes("Executed test command"));

          if (requiresExecution && !hasExecutedTest) {
            item.status = "in_progress";
            item.evidence = `Modified test file in git diff: ${layerMatch}. Pending test execution.`;
            consumedFiles.add(layerMatch);
            continue;
          }
        }
        item.status = "done";
        item.evidence = `Verified newly modified layer file in git diff: ${layerMatch}`;
        consumedFiles.add(layerMatch);
        continue;
      }
    }

    // 2. Remote proxy environment fallback: if git diff is unavailable or 0 newly modified files,
    // but a mutating tool execution was explicitly observed on this item, promote in_progress to done_unverified
    if (
      newlyModifiedFiles.length === 0 &&
      item.status === "in_progress" &&
      item.evidence?.startsWith("Touched")
    ) {
      item.status = "done_unverified";
      item.evidence += " (verified via mutating tool execution; remote proxy mode)";
      continue;
    }

    // Notice: bare conclusion-text claims are explicitly NOT accepted as evidence of completion.
  }

  const openRequired = contract.intents.filter(
    (it) =>
      (it.kind === "explicit" || it.kind === "required-implied") &&
      it.status !== "done" &&
      it.status !== "done_unverified" &&
      it.status !== "blocked"
  );
  const doneItems = contract.intents.filter(
    (it) => it.status === "done" || it.status === "done_unverified"
  );

  let isBlocked = false;
  let suggestedReprompt: string | undefined;

  if (openRequired.length > 0 && strictCompletion) {
    const currentStateDigest = openRequired.map((i) => `${i.id}:${i.status}`).join("|");
    const priorDigest = contract.lastStateDigest;
    let consecutiveNoChange = contract.consecutiveNoChangeReprompts || 0;

    if (priorDigest === currentStateDigest) {
      consecutiveNoChange++;
    } else {
      consecutiveNoChange = 0;
    }

    contract.lastStateDigest = currentStateDigest;
    contract.consecutiveNoChangeReprompts = consecutiveNoChange;

    if (consecutiveNoChange >= 2) {
      isBlocked = true;
      for (const item of openRequired) {
        item.status = "blocked";
        item.evidence = "No progress detected across consecutive re-prompts";
      }
    } else {
      suggestedReprompt =
        `[SPB Completion Gate: Unfulfilled Objectives]\n` +
        `The task cannot be marked complete because the following required checklist items remain unfinished:\n` +
        openRequired
          .map(
            (it) =>
              `- [${it.id}] (${it.layer.toUpperCase()}) [${it.kind}]: ${it.text}\n  Acceptance criteria: ${it.acceptance}`
          )
          .join("\n") +
        `\nPlease execute the necessary operations using your tools (Edit/Write/Bash) to complete and verify these items before concluding.`;
    }
  }

  try {
    updateGuidanceContract(sessionId, contract);
  } catch (err) {
    console.warn("[SPB Outbound] Checkpoint save error during ledger eval:", err);
  }

  const isSatisfied = openRequired.length === 0 || !strictCompletion || isBlocked;

  return {
    isSatisfied,
    openItems: openRequired,
    doneItems,
    suggestedReprompt,
    isBlocked,
  };
}

/**
 * Executes Outbound Intent-Gap Analysis and Autonomous Iterative Re-prompting Loop.
 * Guarantees zero intention loss before delivering response to the caller.
 */
export async function processSpbOutboundZeroLoss(args: {
  initialResponse: Response;
  dispatchModel: (newBody: Record<string, unknown>) => Promise<Response>;
  body: Record<string, unknown>;
  originalPrompt: string;
  preservedIntentions: string[];
  tier: ModelTier;
  taskPhase: TaskPhase;
  sessionId: string;
  maxReprompts?: number;
  workspaceRoot?: string | null;
  spbProfile?: string;
}): Promise<Response> {
  const configuredMaxReprompts = args.maxReprompts ?? 2;
  let currentResponse = args.initialResponse;
  let repromptCount = 0;

  // If initial response was not 200 OK (e.g. 4xx, 5xx), do not re-prompt, let existing fallbacks handle it
  if (!currentResponse.ok) {
    return currentResponse;
  }

  const clientHasTools = Array.isArray(args.body?.tools) && args.body.tools.length > 0;
  let lastExtracted: ExtractedResponseContent | undefined;
  let lastEvalResult: ResponseEvaluationResult | undefined;

  // Scale max reprompts with open items count while capping at profile maxReprompts
  const initialCheckpoint = getCheckpoint(args.sessionId);
  const initialContract = initialCheckpoint?.guidanceContract as GuidanceContract | undefined;
  const initialOpenCount =
    initialContract?.intents?.filter((i) => i.status === "open" || i.status === "in_progress")
      .length || 0;
  const effectiveMaxReprompts = Math.min(configuredMaxReprompts, Math.max(1, initialOpenCount + 1));

  let currentTier = args.tier;
  let consecutiveZeroDiffTurns = 0;
  const sentRepromptHashes = new Set<string>();

  while (repromptCount <= effectiveMaxReprompts) {
    const extracted = await extractResponseContent(currentResponse);
    lastExtracted = extracted;

    // Check for corrupted tool calls (e.g. empty arguments "" or malformed JSON)
    if (extracted.hasCorruptedToolCalls) {
      const nextTier = getNextFailoverTier(currentTier);
      console.warn(
        `[SPB Outbound ZeroLoss] Corrupted tool call detected from upstream model. Promoting tier from ${currentTier} to ${nextTier}.`
      );
      try {
        recordSpbTelemetry({
          sessionId: args.sessionId,
          taskPhase: args.taskPhase,
          modelTier: nextTier,
          checkpointRestored: false,
          fallbackTriggered: true,
          statusCode: 200,
          latencyMs: 0,
          timestamp: Date.now(),
          spbProfile: args.spbProfile || "default",
          operation: "tier_failover_corrupted_tool_call",
          fallbackReason: `Corrupted tool calls emitted in ${currentTier}; escalated to ${nextTier}`,
        });
      } catch {
        // Non-blocking telemetry
      }

      if (nextTier !== currentTier) {
        currentTier = nextTier;
        try {
          const escalatedBody = {
            ...args.body,
            _spbTierPromotion: nextTier,
          };
          const failoverResponse = await args.dispatchModel(escalatedBody);
          if (failoverResponse.ok) {
            currentResponse = failoverResponse;
            continue;
          }
        } catch (failoverErr) {
          console.warn("[SPB Outbound ZeroLoss] Tier failover dispatch failed:", failoverErr);
        }
      }
    }

    // Observe tool calls on active ledger
    if (extracted.hasToolCalls) {
      observeToolCallsOnLedger(args.sessionId, extracted);
    }

    // If the model produced tool calls, mark satisfied immediately; otherwise evaluate whether it stalled
    const evalResult = evaluateResponseIntent(
      args.originalPrompt,
      args.preservedIntentions,
      extracted.text,
      args.tier,
      args.taskPhase,
      args.sessionId,
      extracted.hasToolCalls,
      clientHasTools
    );
    lastEvalResult = evalResult;

    // Conclusion Reviewer: Code Diff & Factual Verification
    // When the agent concludes (no tool calls) and the task involves code modifications,
    // verify the conclusion against the repository code diff to eliminate hallucinated completion claims.
    const isCodePhase =
      args.taskPhase === "CODE_GENERATION" ||
      args.taskPhase === "TESTING_AND_VERIFICATION" ||
      args.taskPhase === "FAST_REFACTOR";

    let reviewerDiscrepancyDetected = false;
    let diffReview: CodeDiffReviewResult | null = null;

    const isNonModificationPhase =
      args.taskPhase === "ARCHITECTURAL_PLANNING" ||
      args.taskPhase === "INSPECTION_SYNTHESIS" ||
      args.taskPhase === "DETERMINISTIC_ROUTING";

    const claimsEditsInText =
      /\b(I have (?:implemented|applied|modified|updated|created|fixed|resolved)|changes (?:are|have been) (?:applied|made|committed)|(?:resolved|fixed|implemented|updated|verified)\s*&\s*verified|tests?\s*(?:passed|verified)|deployed?\s*(?:successfully|cleanly))\b/i.test(
        extracted.text.trim()
      );

    if (
      !extracted.hasToolCalls &&
      isCodePhase &&
      !isNonModificationPhase &&
      extracted.text.trim() &&
      claimsEditsInText
    ) {
      diffReview = verifyCodeDiffAgainstConclusion(extracted.text, args.workspaceRoot ?? undefined);
      if (!diffReview.passed && diffReview.report) {
        reviewerDiscrepancyDetected = true;
        evalResult.isSatisfied = false;
        evalResult.satisfactionScore = Math.min(evalResult.satisfactionScore, 0.4);
        evalResult.oddities.push(
          "Conclusion claimed code modifications not reflected in repository code diff."
        );
        evalResult.reviewerDiscrepancies = diffReview.claimedFilesMissingInDiff;
        evalResult.reviewerReport = diffReview.report;
        evalResult.suggestedReprompt = diffReview.report;
        console.log(
          `[SPB Outbound ZeroLoss] Reviewer check failed for session ${args.sessionId}: ${diffReview.claimedFilesMissingInDiff.length} claimed files missing in git diff. Re-prompting agent with feedback.`
        );
      }
    }

    // Ledger completion evaluation scoped to active SPB profile
    const tierCfg = getTierConfig(args.spbProfile);
    const activeContract = getCheckpoint(args.sessionId)?.guidanceContract as
      GuidanceContract | undefined;
    const isStrict = Boolean(
      activeContract?.strictCompletion ?? tierCfg?.spbConfig?.strictCompletion ?? false
    );

    const mode = tierCfg?.spbConfig?.intentLedgerMode ?? "off";
    let ledgerEval: LedgerEvaluationResult | undefined;
    if (!extracted.hasToolCalls && activeContract?.intents?.length) {
      if (mode === "apex_shadow" || (mode === "apex_guided" && isStrict)) {
        const cwd = resolveDiffCwd();
        const currentSnapshot = snapshotWorkingTreeDirtyFiles(cwd);
        const baselineHashes = activeContract.baselineFileHashes || {};
        const diffFiles = currentSnapshot.files.filter(
          (f) => currentSnapshot.hashes[f] !== baselineHashes[f]
        );
        const diffDelta = {
          files: diffFiles,
          hashes: currentSnapshot.hashes,
        };

        const toolEvidence = extractToolEvidenceFromMessages(args.body?.messages as unknown[]);
        const combinedTestCommands = [
          ...((activeContract.executedTestCommands as Array<{
            command: string;
            exitCode: number;
          }>) || []),
          ...toolEvidence.executedTestCommands,
        ];
        const combinedReadFiles = Array.from(
          new Set([...(activeContract.observedReadFiles || []), ...toolEvidence.observedReadFiles])
        );
        const combinedWrittenFiles = Array.from(
          new Set([
            ...(activeContract.observedWrittenFiles || []),
            ...toolEvidence.observedWrittenFiles,
          ])
        );

        const mechanicalEvidence: MechanicalEvidence = {
          diffDelta,
          testCommands: combinedTestCommands,
          observedReadFiles: combinedReadFiles,
          observedWrittenFiles: combinedWrittenFiles,
          diffVisible: Boolean(args.workspaceRoot && fs.existsSync(args.workspaceRoot)),
          sharedWorkspace: Boolean(activeContract.sharedWorkspace),
        };

        const judgeDispatch: ModelDispatchFn = async (p) => {
          const res = await args.dispatchModel({
            messages: p.messages,
            temperature: p.temperature ?? 0,
            response_format: p.response_format,
          });
          return await res.text();
        };

        const judgeStartTime = Date.now();
        const judgeResult = await judgeCompletion(
          activeContract.intents,
          mechanicalEvidence,
          extracted.text,
          judgeDispatch,
          {
            sessionId: args.sessionId,
            profile: args.spbProfile,
            taskPhase: args.taskPhase,
            modelTier: args.tier,
          }
        );
        const judgeLatencyMs = Date.now() - judgeStartTime;

        // Update items in contract
        for (const jItem of judgeResult.items) {
          const matched = activeContract.intents.find((it) => it.id === jItem.id);
          if (matched) {
            matched.status = jItem.status;
            matched.evidence = jItem.evidence;
          }
        }

        if (judgeResult.outOfScopeFiles.length > 0) {
          activeContract.outOfScopeViolations = judgeResult.outOfScopeFiles;
        }

        updateGuidanceContract(args.sessionId, activeContract);

        if (mode === "apex_shadow") {
          // Shadow mode: log decisions to telemetry with full ledger and judge verdict, inject nothing, never reprompt
          const openItems = judgeResult.items.filter(
            (it) => it.status !== "done" && it.status !== "skipped"
          );
          try {
            recordSpbTelemetry({
              sessionId: args.sessionId,
              taskPhase: args.taskPhase,
              modelTier: args.tier,
              checkpointRestored: false,
              fallbackTriggered: false, // Normal judge evaluation is NOT a system fallback
              statusCode: 200,
              latencyMs: judgeLatencyMs,
              timestamp: Date.now(),
              spbProfile: args.spbProfile || "default",
              operation: "shadow_judge",
              intentLedger: JSON.stringify(activeContract.intents),
              judgeDecision: JSON.stringify({
                items: judgeResult.items,
                isSatisfied: judgeResult.isSatisfied,
                outOfScopeFiles: judgeResult.outOfScopeFiles,
              }),
              repromptText: judgeResult.reprompt || "",
              fallbackReason: undefined,
              openItemsCount: openItems.length,
              openItemsSummary:
                openItems.length > 0
                  ? openItems.map((i) => `${i.id}: ${i.status}`).join(", ")
                  : undefined,
            });
          } catch {
            // Ignore
          }
          evalResult.isSatisfied = true;
        } else {
          // apex_guided mode
          if (!judgeResult.isSatisfied && judgeResult.reprompt) {
            evalResult.isSatisfied = false;
            evalResult.suggestedReprompt = judgeResult.reprompt;
          } else {
            evalResult.isSatisfied = true;
          }
        }
      } else if (isStrict) {
        ledgerEval = evaluateLedgerCompletion(args.sessionId, extracted.text, diffReview, isStrict);
        if (!ledgerEval.isSatisfied && ledgerEval.suggestedReprompt) {
          evalResult.isSatisfied = false;
          evalResult.suggestedReprompt = ledgerEval.suggestedReprompt;
          evalResult.satisfactionScore = Math.max(
            0.2,
            ledgerEval.doneItems.length /
              Math.max(1, ledgerEval.doneItems.length + ledgerEval.openItems.length)
          );
        }
      }
    }

    let newlyModifiedCount = 0;
    if (diffReview?.actualModifiedFiles) {
      newlyModifiedCount = diffReview.actualModifiedFiles.length;
    }

    // Phase-based exemption: non-mutating phases are exempt from zero-diff penalty.
    const nonMutatingPhases = new Set([
      "INSPECTION_SYNTHESIS",
      "ARCHITECTURAL_PLANNING",
      "UNDERSTAND",
      "REVIEW",
      "ANALYSIS",
      "DETERMINISTIC_ROUTING",
    ]);

    const currentPhase = args.taskPhase ?? null;

    const isExemptFromZeroDiffPenalty =
      (currentPhase !== null && nonMutatingPhases.has(currentPhase)) ||
      (currentPhase === null &&
        /\b(analyz|review|investigat|inspect|diagnos)\b/i.test(args.originalPrompt || "")) ||
      /^(?:how\s+(?:to|can|do|should)|why\s+|what\s+|explain\s+|tell\s+me)\b/i.test(
        (args.originalPrompt || "").trim()
      );

    if (isExemptFromZeroDiffPenalty) {
      evalResult.isSatisfied = true;
      evalResult.suggestedReprompt = undefined;
    } else if (
      mode !== "apex_shadow" &&
      !extracted.hasToolCalls &&
      newlyModifiedCount === 0 &&
      (extracted.observedToolCalls?.length ?? 0) === 0
    ) {
      consecutiveZeroDiffTurns++;
      if (consecutiveZeroDiffTurns === 1) {
        evalResult.suggestedReprompt =
          "Before making any edits, formulate a complete multi-file plan covering all files to be changed, the order of changes, and expected outcomes. Only begin editing after the plan is fully formed.";
        evalResult.isSatisfied = false;
      } else if (consecutiveZeroDiffTurns >= 2) {
        const promotedTier = getNextFailoverTier(currentTier);
        if (promotedTier !== currentTier && promotedTier !== "tier_1_apex") {
          console.warn(
            `[SPB Outbound ZeroLoss] Consecutive zero-diff turns detected. Escalating from ${currentTier} to ${promotedTier}.`
          );
          currentTier = promotedTier;
          try {
            const escalatedBody = {
              ...args.body,
              _spbTierPromotion: promotedTier,
            };
            const failoverResponse = await args.dispatchModel(escalatedBody);
            if (failoverResponse.ok) {
              currentResponse = failoverResponse;
              continue;
            }
          } catch {}
        } else {
          // At Apex tier or cannot escalate further: halt loop cleanly, mark open items blocked
          evalResult.isSatisfied = true;
          if (activeContract?.intents) {
            for (const item of activeContract.intents) {
              if (item.status === "open" || item.status === "in_progress") {
                item.status = "blocked";
                item.evidence = "Terminated: consecutive zero-diff turns reached tier limit";
              }
            }
            updateGuidanceContract(args.sessionId, activeContract);
          }
        }
      }
    } else if (extracted.hasToolCalls || newlyModifiedCount > 0) {
      consecutiveZeroDiffTurns = 0;
    }

    console.log(
      `[SPB Outbound ZeroLoss] Session ${args.sessionId} | Phase: ${args.taskPhase} | Tier: ${currentTier} | Satisfaction: ${evalResult.satisfactionScore.toFixed(2)} | Satisfied: ${evalResult.isSatisfied} | Omissions: ${evalResult.omissions.length} | ReviewerDiscrepancy: ${reviewerDiscrepancyDetected} | RepromptCount: ${repromptCount}`
    );

    // If response satisfies 100% of intention criteria, max iterations reached, or tool call generated
    if (
      evalResult.isSatisfied ||
      repromptCount >= effectiveMaxReprompts ||
      extracted.hasToolCalls
    ) {
      // Build completion summary report if concluding turn and exhausted or blocked
      let ledgerSummary: string | undefined;
      const isExhaustedOrBlocked =
        !extracted.hasToolCalls &&
        (repromptCount >= effectiveMaxReprompts ||
          Boolean(ledgerEval?.isBlocked) ||
          consecutiveZeroDiffTurns >= 2);
      if (isExhaustedOrBlocked) {
        const finalContract = getCheckpoint(args.sessionId)?.guidanceContract as
          GuidanceContract | undefined;
        if (finalContract?.intents?.length) {
          ledgerSummary = buildLedgerSummaryReport(finalContract.intents);
        }
      }

      try {
        recordIntentEvaluation({
          sessionId: args.sessionId,
          promptAnchorHash: "spb_" + args.sessionId,
          tier: args.tier,
          taskPhase: args.taskPhase,
          satisfactionScore: evalResult.satisfactionScore,
          detectedOmissions: JSON.stringify(evalResult.omissions || []),
          repromptCount,
          repromptSuccess: evalResult.isSatisfied,
          evaluatedAt: Date.now(),
        });
      } catch {
        // Non-blocking telemetry
      }

      if (extracted.isStream) {
        return reconstructStreamResponse(
          extracted.rawChunks,
          currentResponse,
          evalResult,
          repromptCount,
          ledgerSummary
        );
      } else {
        const headers = new Headers(currentResponse.headers);
        headers.set("X-OmniRoute-SPB-Satisfaction", evalResult.satisfactionScore.toFixed(2));
        headers.set("X-OmniRoute-SPB-Reprompt-Count", String(repromptCount));
        headers.set("X-OmniRoute-SPB-ZeroLoss", evalResult.isSatisfied ? "verified" : "partial");
        if (ledgerSummary) {
          headers.set("X-OmniRoute-SPB-Ledger-Summary", "included");
        }
        headers.set(
          "X-OmniRoute-Reviewer-Status",
          evalResult.reviewerReport ? "reviewed-with-corrections" : "verified"
        );
        if (ledgerSummary && extracted.jsonBody) {
          const choices = (extracted.jsonBody as Record<string, unknown>).choices as
            Array<Record<string, unknown>> | undefined;
          const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
          if (msg && typeof msg.content === "string") {
            msg.content += "\n\n" + ledgerSummary;
          }
        }
        return new Response(JSON.stringify(extracted.jsonBody || {}), {
          status: currentResponse.status,
          statusText: currentResponse.statusText,
          headers,
        });
      }
    }

    // Response failed criteria: formulate targeted re-prompt and query upstream again
    // For empty or severely truncated outputs in autonomous / tool-using sessions, supply a continuation prompt
    let repromptText =
      evalResult.suggestedReprompt ||
      (!extracted.text.trim()
        ? "Your previous response was empty or contained no user-visible output or tool execution. Please continue autonomous execution immediately and supply substantive progress or output."
        : undefined);

    if (!repromptText) {
      break;
    }

    // Never repeat the exact same reprompt text; if already sent, differentiate or stop
    if (sentRepromptHashes.has(repromptText.trim())) {
      repromptText = `${repromptText.trim()} (Attempt ${repromptCount + 1}: please address the outstanding items directly).`;
      if (sentRepromptHashes.has(repromptText.trim())) {
        break;
      }
    }
    sentRepromptHashes.add(repromptText.trim());

    repromptCount++;
    const currentMessages = Array.isArray(args.body?.messages)
      ? (args.body.messages as Array<Record<string, unknown>>)
      : [];
    const repromptMessages = pruneOldToolOutputsForReprompt([
      ...currentMessages,
      ...(extracted.text.trim() ? [{ role: "assistant", content: extracted.text }] : []),
      { role: "user", content: repromptText },
    ]);

    try {
      const nextBody = {
        ...args.body,
        messages: repromptMessages,
      };
      const nextResponse = await args.dispatchModel(nextBody);
      if (!nextResponse.ok) {
        // Upstream error on re-query; break and return best response so far
        break;
      }
      currentResponse = nextResponse;
    } catch {
      break;
    }
  }

  // Safety fallback: if loop exited via break or error, ALWAYS reconstruct from lastExtracted
  // because currentResponse stream has already been consumed!
  if (lastExtracted) {
    const fallbackEval = lastEvalResult || {
      isSatisfied: false,
      satisfactionScore: 0.0,
      omissions: ["Response loop terminated prematurely before satisfying requirements."],
      oddities: [],
      repromptCount,
    };
    if (lastExtracted.isStream) {
      return reconstructStreamResponse(
        lastExtracted.rawChunks,
        currentResponse,
        fallbackEval,
        repromptCount
      );
    } else {
      const headers = new Headers(currentResponse.headers);
      headers.set("X-OmniRoute-SPB-Satisfaction", fallbackEval.satisfactionScore.toFixed(2));
      headers.set("X-OmniRoute-SPB-Reprompt-Count", String(repromptCount));
      headers.set("X-OmniRoute-SPB-ZeroLoss", fallbackEval.isSatisfied ? "verified" : "partial");
      if (fallbackEval.reviewerReport) {
        headers.set(
          "X-OmniRoute-Reviewer-Status",
          fallbackEval.isSatisfied ? "verified" : "discrepancy-unresolved"
        );
      } else {
        headers.set("X-OmniRoute-Reviewer-Status", "verified");
      }
      const jsonBody = lastExtracted.jsonBody
        ? (JSON.parse(JSON.stringify(lastExtracted.jsonBody)) as Record<string, unknown>)
        : {};
      // Header-only reviewer signaling; do not mutate assistant JSON content with the discrepancy
      // notice, which would re-trigger the loop on subsequent turns.
      return new Response(JSON.stringify(jsonBody), {
        status: currentResponse.status,
        statusText: currentResponse.statusText,
        headers,
      });
    }
  }

  return currentResponse;
}
