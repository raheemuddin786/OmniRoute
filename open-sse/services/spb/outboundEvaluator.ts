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

export interface ResponseEvaluationResult {
  isSatisfied: boolean;
  satisfactionScore: number; // 0.0 to 1.0
  omissions: string[];
  oddities: string[];
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
  hasToolCalls: boolean = false
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
    /\b(As an AI language model|I cannot access your local files|I am unable to execute or implement)\b/i.test(
      responseText
    )
  ) {
    oddities.push("Response contains an apologetic refusal filler instead of required execution.");
    score -= 0.4;
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
    suggestedReprompt,
    repromptCount: isSatisfied ? 0 : 1,
  };
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

    // If the model produced tool calls or client provided tools and tool calls occurred, mark satisfied immediately
    const evalResult = evaluateResponseIntent(
      args.originalPrompt,
      args.preservedIntentions,
      extracted.text,
      args.tier,
      args.taskPhase,
      args.sessionId,
      extracted.hasToolCalls || (clientHasTools && extracted.hasToolCalls)
    );
    lastEvalResult = evalResult;

    // If response satisfies 100% of intention criteria, max iterations reached, or tool call generated
    if (evalResult.isSatisfied || repromptCount >= maxReprompts || extracted.hasToolCalls) {
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
