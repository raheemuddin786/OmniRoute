/**
 * SPB-IR Proxy Bridge Orchestration & Zero-Loss Fallback Service (Production Hardened)
 * Coordinates intent analysis, tiered model routing, state checkpointing,
 * telemetry auditing, and autonomous zero-loss fallback recovery with full fault tolerance.
 */

import { classifyIntent, IntentProfile } from "./intentAnalyzer.ts";
import { selectModelTier, TierAssignment } from "./tieredRegistry.ts";
import { getTierConfig } from "../tierResolver.ts";
import { saveCheckpoint, getCheckpoint, recordSpbTelemetry } from "../../../src/lib/db/spbState.ts";
import {
  maybeCcrReplace,
  storeBlock,
  DEFAULT_MIN_CHARS,
  RETRIEVAL_RAMP_FACTOR_DEFAULT,
} from "../compression/engines/ccr/index.ts";
import { forkSession, ForkedSessionContext } from "./branchManager.ts";
import {
  decomposeRequestIntoSubTasks,
  executeParallelPhase,
  executeSequentialPhase,
  type SubTask,
  type PartitionedContext,
  type VerifiedArtifactContract,
  type DecompositionResult,
} from "./contextPartition.ts";
import {
  enhanceInboundPrompt,
  evaluateRequestNecessity,
  computePatternHash,
  type PromptEnhancementResult,
  type NecessityCheckResult,
} from "./inboundIntelligence.ts";
import {
  evaluateResponseIntent,
  processSpbOutboundZeroLoss,
  extractResponseContent,
  type ResponseEvaluationResult,
  type ExtractedResponseContent,
} from "./outboundEvaluator.ts";

export {
  forkSession,
  type ForkedSessionContext,
  decomposeRequestIntoSubTasks,
  executeParallelPhase,
  executeSequentialPhase,
  type SubTask,
  type PartitionedContext,
  type VerifiedArtifactContract,
  type DecompositionResult,
  enhanceInboundPrompt,
  evaluateRequestNecessity,
  computePatternHash,
  evaluateResponseIntent,
  processSpbOutboundZeroLoss,
  extractResponseContent,
  type PromptEnhancementResult,
  type NecessityCheckResult,
  type ResponseEvaluationResult,
  type ExtractedResponseContent,
};

export interface SpbRoutingContext {
  sessionId?: string;
  messages: Array<{ role: string; content?: string }>;
  tools?: unknown[];
}

export interface SpbRoutingDecision {
  intent: IntentProfile;
  tierAssignment: TierAssignment;
  selectedModel: string | null;
  checkpointRestored: boolean;
  enhancement?: PromptEnhancementResult;
  necessity?: NecessityCheckResult;
  enhancedMessages?: Array<{ role: string; content?: unknown }>;
  error?: string;
}

export async function processSmartProxyRouting(
  context: SpbRoutingContext
): Promise<SpbRoutingDecision> {
  const startTime = Date.now();
  const sessionId = context.sessionId || "default_session_" + Date.now();

  try {
    // 1. Defensive payload validation
    const messages = Array.isArray(context.messages)
      ? context.messages
      : [{ role: "user", content: String(context.messages || "") }];
    const tools = Array.isArray(context.tools) ? context.tools : undefined;

    // 1b. CCR ingress offloading: replace large tool outputs with CCR markers
    // to prevent context bloat before intent classification
    const processedMessages = await Promise.all(
      messages.map(async (msg) => {
        if (typeof msg.content === "string" && msg.content.length >= DEFAULT_MIN_CHARS) {
          const { text, replaced, hash } = maybeCcrReplace(
            msg.content,
            DEFAULT_MIN_CHARS,
            sessionId,
            RETRIEVAL_RAMP_FACTOR_DEFAULT
          );
          if (replaced && hash) {
            // Store the original content for later retrieval
            storeBlock(msg.content, sessionId, { source: "compression" });
            return { ...msg, content: text };
          }
        } else if (Array.isArray(msg.content)) {
          // Handle multi-part messages (Anthropic format)
          const processedParts = await Promise.all(
            msg.content.map(async (part) => {
              if (
                part &&
                typeof part === "object" &&
                part.type === "text" &&
                typeof part.text === "string" &&
                part.text.length >= DEFAULT_MIN_CHARS
              ) {
                const { text, replaced, hash } = maybeCcrReplace(
                  part.text,
                  DEFAULT_MIN_CHARS,
                  sessionId,
                  RETRIEVAL_RAMP_FACTOR_DEFAULT
                );
                if (replaced && hash) {
                  storeBlock(part.text, sessionId, { source: "compression" });
                  return { ...part, text };
                }
              }
              return part;
            })
          );
          return { ...msg, content: processedParts };
        }
        return msg;
      })
    );

    // 2. Classify intent with error boundary (using CCR-processed messages)
    const intent = classifyIntent(processedMessages, tools);

    // 3. Select model tier using dynamic config and tool requirements
    // Pass isToolResultTurn AND guidanceContract to enforce supervision
    // Tier 3 will require a guidanceContract for mutation/refactoring phases
    const tierConfig = getTierConfig();
    let tierAssignment = selectModelTier(
      intent.taskPhase,
      intent.complexityScore,
      tierConfig?.tierModels,
      intent.requiresTools,
      intent.isToolResultTurn,
      intent.guidanceContract
    );

    // 4. Check for existing checkpoint & state resumption with safe error handling
    let checkpointRestored = false;
    let existingCheckpoint = null;
    let restoredModel: string | null = null;
    try {
      existingCheckpoint = getCheckpoint(sessionId);
      if (existingCheckpoint && existingCheckpoint.promptAnchorHash === intent.promptAnchorHash) {
        // Model continuity: only preserve model continuity when the active turn is within the same tier.
        // Never force execution, code generation, testing, or refactoring into Tier 1.
        if (existingCheckpoint.modelTier === tierAssignment.tier) {
          checkpointRestored = true;
          if (existingCheckpoint.statePayload) {
            try {
              const parsed = JSON.parse(existingCheckpoint.statePayload);
              if (
                typeof parsed.modelName === "string" &&
                tierAssignment.recommendedModels.includes(parsed.modelName)
              ) {
                restoredModel = parsed.modelName;
              }
            } catch {
              // Ignore corrupted payload JSON
            }
          }
        }
      }
    } catch (dbErr) {
      console.warn(
        "[SPB Bridge] Checkpoint retrieval warning (proceeding without checkpoint):",
        dbErr
      );
    }

    const selectedModel =
      restoredModel ||
      (tierAssignment.recommendedModels && tierAssignment.recommendedModels.length > 0
        ? tierAssignment.recommendedModels[0]
        : null);

    // 5. Save new state checkpoint asynchronously / safely
    // Include guidanceContract in checkpoint for session restore and verification loop
    try {
      saveCheckpoint({
        sessionId,
        promptAnchorHash: intent.promptAnchorHash,
        taskPhase: intent.taskPhase,
        modelTier: tierAssignment.tier,
        guidanceContract: tierAssignment.guidanceContract,
        statePayload: JSON.stringify({
          messagesCount: messages.length,
          timestamp: Date.now(),
          modelName: selectedModel,
        }),
        createdAt: Date.now(),
      });
    } catch (dbSaveErr) {
      console.warn("[SPB Bridge] Checkpoint save warning:", dbSaveErr);
    }

    const latencyMs = Date.now() - startTime;

    // 6. Inbound Intelligence, Prompt Enhancement & Necessity Gate
    let lastUserIndex = -1;
    let lastUserText = "";
    for (let i = processedMessages.length - 1; i >= 0; i--) {
      if (processedMessages[i]?.role === "user") {
        lastUserIndex = i;
        const c = processedMessages[i].content;
        lastUserText = typeof c === "string" ? c : Array.isArray(c) ? JSON.stringify(c) : "";
        break;
      }
    }

    const enhancement = lastUserText
      ? enhanceInboundPrompt(lastUserText, tierAssignment.tier, intent.taskPhase, processedMessages)
      : undefined;

    let enhancedMessages: Array<{ role: string; content?: unknown }> | undefined;
    if (enhancement && enhancement.enhancedPrompt !== lastUserText && lastUserIndex >= 0) {
      enhancedMessages = processedMessages.map((m, idx) => {
        if (idx === lastUserIndex) {
          return { ...m, content: enhancement.enhancedPrompt };
        }
        return m;
      });
    }

    // 7. Record telemetry audit
    try {
      recordSpbTelemetry({
        sessionId,
        taskPhase: intent.taskPhase,
        modelTier: tierAssignment.tier,
        checkpointRestored,
        fallbackTriggered: false,
        statusCode: 200,
        latencyMs,
        timestamp: Date.now(),
      });
    } catch (telemErr) {
      console.warn("[SPB Bridge] Telemetry recording warning:", telemErr);
    }

    return {
      intent,
      tierAssignment,
      selectedModel,
      checkpointRestored,
      enhancement,
      necessity: enhancement?.necessity,
      enhancedMessages,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[SPB Bridge] Fatal routing error, falling back to resilient tier:", errorMsg);

    // Graceful fallback decision to prevent unhandled request crashes
    const fallbackIntent: IntentProfile = {
      taskPhase: "CODE_GENERATION",
      estimatedTokens: 1000,
      requiresTools: false,
      isToolResultTurn: false,
      complexityScore: 0.5,
      promptAnchorHash: "sha256:spb_fallback_" + Date.now(),
    };

    const tierConfig = getTierConfig();
    const fallbackTier = selectModelTier(
      fallbackIntent.taskPhase,
      fallbackIntent.complexityScore,
      tierConfig?.tierModels
    );
    const fallbackModel =
      fallbackTier.recommendedModels && fallbackTier.recommendedModels.length > 0
        ? fallbackTier.recommendedModels[0]
        : null;

    return {
      intent: fallbackIntent,
      tierAssignment: fallbackTier,
      selectedModel: fallbackModel,
      checkpointRestored: false,
      error: errorMsg,
    };
  }
}

export function shouldTriggerZeroLossFallback(statusCode: number): boolean {
  // Trigger recovery on rate limits, bad requests (model-scoped rejections), credits exhaustion, gateway errors, or timeouts
  return (
    statusCode === 400 ||
    statusCode === 402 ||
    statusCode === 408 ||
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504
  );
}
