/**
 * SPB-IR Proxy Bridge Orchestration & Zero-Loss Fallback Service (Production Hardened)
 * Coordinates intent analysis, tiered model routing, state checkpointing,
 * telemetry auditing, and autonomous zero-loss fallback recovery with full fault tolerance.
 */

import { classifyIntent, IntentProfile } from "./intentAnalyzer.ts";
import { selectModelTier, TierAssignment } from "./tieredRegistry.ts";
import { getTierConfig } from "../tierResolver.ts";
import { saveCheckpoint, getCheckpoint, recordSpbTelemetry } from "../../../src/lib/db/spbState.ts";

export interface SpbRoutingContext {
  sessionId?: string;
  messages: Array<{ role: string; content?: string }>;
  tools?: unknown[];
}

export interface SpbRoutingDecision {
  intent: IntentProfile;
  tierAssignment: TierAssignment;
  selectedModel: string;
  checkpointRestored: boolean;
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

    // 2. Classify intent with error boundary
    const intent = classifyIntent(messages, tools);

    // 3. Select model tier using dynamic config and tool requirements
    const tierConfig = getTierConfig();
    let tierAssignment = selectModelTier(
      intent.taskPhase,
      intent.complexityScore,
      tierConfig?.tierModels,
      intent.requiresTools
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
        : "claude-3-5-sonnet");

    // 5. Save new state checkpoint asynchronously / safely
    try {
      saveCheckpoint({
        sessionId,
        promptAnchorHash: intent.promptAnchorHash,
        taskPhase: intent.taskPhase,
        modelTier: tierAssignment.tier,
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

    // 6. Record telemetry audit
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
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[SPB Bridge] Fatal routing error, falling back to resilient tier:", errorMsg);

    // Graceful fallback decision to prevent unhandled request crashes
    const fallbackIntent: IntentProfile = {
      taskPhase: "CODE_GENERATION",
      estimatedTokens: 1000,
      requiresTools: false,
      complexityScore: 0.5,
      promptAnchorHash: "sha256:spb_fallback_" + Date.now(),
    };

    const fallbackTier = selectModelTier(fallbackIntent.taskPhase, fallbackIntent.complexityScore);
    const fallbackModel =
      fallbackTier.recommendedModels && fallbackTier.recommendedModels.length > 0
        ? fallbackTier.recommendedModels[0]
        : "claude-3-5-sonnet";

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
