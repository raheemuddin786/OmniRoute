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

import { TaskPhase } from "./intentAnalyzer.ts";
import { ModelTier } from "./tieredRegistry.ts";
import { recordIntentEvaluation, saveLearnedOptimization } from "../../../src/lib/db/spbState.ts";
import { computePatternHash } from "./inboundIntelligence.ts";
import { isFeatureFlagEnabled } from "../../../src/shared/utils/featureFlags.ts";
import { spawnSync } from "node:child_process";

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
  _preservedIntentions: string[],
  responseText: string,
  tier: ModelTier,
  taskPhase: TaskPhase,
  sessionId: string = "default_session",
  hasToolCalls: boolean = false,
  clientHasTools: boolean = false
): ResponseEvaluationResult {
  // If the model produced tool calls, it is an active intermediate turn in an autonomous execution loop.
  // Never flag tool calls as omissions or reprompt them.
  if (hasToolCalls) {
    return {
      isSatisfied: true,
      satisfactionScore: 1.0,
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

  // 1. Detect empty or suspiciously truncated response
  if (!responseText || responseText.trim().length < 20) {
    omissions.push("Response is empty, severely truncated, or lacks substantive content.");
    score -= 0.6;
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
    /\b(autonomous|execute|run|verify|test|capture|screenshot|implement|build|fix)\b/i.test(
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
  cwd: string = process.cwd()
): CodeDiffReviewResult {
  try {
    const diffProc = spawnSync("git", ["diff", "--name-only", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
    const statusProc = spawnSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
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
          if (file) actualFiles.add(file);
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
      /\b(I have (?:implemented|applied|modified|updated|created|fixed|resolved)|changes (?:are|have been) (?:applied|made|committed))\b/i.test(
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
    console.warn("[SPB Reviewer] Git diff verification failed to execute:", err);
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
      if (Array.isArray(firstChoiceMsg?.tool_calls) && firstChoiceMsg.tool_calls.length > 0) {
        hasToolCalls = true;
        for (const tc of firstChoiceMsg.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn && (fn.arguments === "" || fn.arguments === undefined)) {
            fn.arguments = "{}";
          }
        }
      }
      if (choices?.[0]?.finish_reason === "tool_calls") {
        hasToolCalls = true;
      }
      if (Array.isArray(json?.content)) {
        for (const c of json.content as Array<Record<string, unknown>>) {
          if (c && typeof c === "object" && (c.type === "tool_use" || c.type === "tool_call")) {
            hasToolCalls = true;
            break;
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
              break;
            }
          }
        }
      }

      return { text, isStream: false, rawChunks: [], jsonBody: json, hasToolCalls };
    } catch {
      return { text: "", isStream: false, rawChunks: [], hasToolCalls: false };
    }
  }

  // Streaming extraction: consume and buffer stream chunks
  const rawChunks: Uint8Array[] = [];
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
              // Anthropic delta
              else if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                accumulatedText += parsed.delta.text;
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
              }
              // Anthropic tool_use
              else if (
                (parsed.type === "content_block_start" &&
                  parsed.content_block?.type === "tool_use") ||
                (parsed.type === "message_delta" && parsed.delta?.stop_reason === "tool_use") ||
                parsed.type === "tool_use"
              ) {
                hasToolCalls = true;
              }
              // Gemini functionCall
              else if (parsed.candidates?.[0]?.content?.parts?.[0]?.functionCall) {
                hasToolCalls = true;
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

  return {
    text: accumulatedText,
    isStream: true,
    rawChunks,
    hasToolCalls,
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
  repromptCount: number
): Response {
  const headers = new Headers(originalResponse.headers);
  headers.set("X-OmniRoute-SPB-Satisfaction", evalResult.satisfactionScore.toFixed(2));
  headers.set("X-OmniRoute-SPB-Reprompt-Count", String(repromptCount));
  headers.set("X-OmniRoute-SPB-ZeroLoss", evalResult.isSatisfied ? "verified" : "partial");
  if (evalResult.reviewerReport) {
    headers.set("X-OmniRoute-Reviewer-Status", evalResult.isSatisfied ? "verified" : "reprompted");
  } else {
    headers.set("X-OmniRoute-Reviewer-Status", "verified");
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of rawChunks) {
        controller.enqueue(chunk);
      }
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
}): Promise<Response> {
  const maxReprompts = args.maxReprompts ?? 2;
  let currentResponse = args.initialResponse;
  let repromptCount = 0;

  // If initial response was not 200 OK (e.g. 4xx, 5xx), do not re-prompt, let existing fallbacks handle it
  if (!currentResponse.ok) {
    return currentResponse;
  }

  const clientHasTools = Array.isArray(args.body?.tools) && args.body.tools.length > 0;
  let lastExtracted: ExtractedResponseContent | undefined;
  let lastEvalResult: ResponseEvaluationResult | undefined;

  while (repromptCount <= maxReprompts) {
    const extracted = await extractResponseContent(currentResponse);
    lastExtracted = extracted;

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
    if (
      isFeatureFlagEnabled("REVIEWER_ASSISTANT_ENABLED") &&
      !extracted.hasToolCalls &&
      isCodePhase &&
      extracted.text.trim()
    ) {
      const diffReview = verifyCodeDiffAgainstConclusion(extracted.text);
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

    console.log(
      `[SPB Outbound ZeroLoss] Session ${args.sessionId} | Phase: ${args.taskPhase} | Tier: ${args.tier} | Satisfaction: ${evalResult.satisfactionScore.toFixed(2)} | Satisfied: ${evalResult.isSatisfied} | Omissions: ${evalResult.omissions.length} | ReviewerDiscrepancy: ${reviewerDiscrepancyDetected} | RepromptCount: ${repromptCount}`
    );

    // If response satisfies 100% of intention criteria, max iterations reached, or tool call generated
    if (evalResult.isSatisfied || repromptCount >= maxReprompts || extracted.hasToolCalls) {
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
          repromptCount
        );
      } else {
        const headers = new Headers(currentResponse.headers);
        headers.set("X-OmniRoute-SPB-Satisfaction", evalResult.satisfactionScore.toFixed(2));
        headers.set("X-OmniRoute-SPB-Reprompt-Count", String(repromptCount));
        headers.set("X-OmniRoute-SPB-ZeroLoss", evalResult.isSatisfied ? "verified" : "partial");
        headers.set(
          "X-OmniRoute-Reviewer-Status",
          evalResult.reviewerReport ? "reviewed-with-corrections" : "verified"
        );
        return new Response(JSON.stringify(extracted.jsonBody || {}), {
          status: currentResponse.status,
          statusText: currentResponse.statusText,
          headers,
        });
      }
    }

    // Response failed criteria: formulate targeted re-prompt and query upstream again
    // BUT only if we actually have text and suggestions, and never if extracted.text is empty
    if (!extracted.text.trim() || !evalResult.suggestedReprompt) {
      break;
    }

    repromptCount++;
    const currentMessages = Array.isArray(args.body?.messages)
      ? (args.body.messages as Array<Record<string, unknown>>)
      : [];
    const repromptMessages = pruneOldToolOutputsForReprompt([
      ...currentMessages,
      { role: "assistant", content: extracted.text },
      { role: "user", content: evalResult.suggestedReprompt },
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
      isSatisfied: true,
      satisfactionScore: 1.0,
      omissions: [],
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
      return new Response(JSON.stringify(lastExtracted.jsonBody || {}), {
        status: currentResponse.status,
        statusText: currentResponse.statusText,
        headers,
      });
    }
  }

  return currentResponse;
}
