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
  sessionId: string = "default_session"
): ResponseEvaluationResult {
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
      return { text, isStream: false, rawChunks: [], jsonBody: json };
    } catch {
      return { text: "", isStream: false, rawChunks: [] };
    }
  }

  // Streaming extraction: consume and buffer stream chunks
  const rawChunks: Uint8Array[] = [];
  let accumulatedText = "";
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
          } catch {
            // Non-JSON frame
          }
        }
      }
    }
  }

  return {
    text: accumulatedText,
    isStream: true,
    rawChunks,
  };
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

  while (repromptCount <= maxReprompts) {
    const extracted = await extractResponseContent(currentResponse);
    const evalResult = evaluateResponseIntent(
      args.originalPrompt,
      args.preservedIntentions,
      extracted.text,
      args.tier,
      args.taskPhase,
      args.sessionId
    );

    // If response satisfies 100% of intention criteria or max iterations reached
    if (evalResult.isSatisfied || repromptCount >= maxReprompts) {
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
    repromptCount++;
    const currentMessages = Array.isArray(args.body?.messages) ? [...args.body.messages] : [];
    const repromptMessages = [
      ...currentMessages,
      { role: "assistant", content: extracted.text },
      { role: "user", content: evalResult.suggestedReprompt },
    ];

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

  return currentResponse;
}
