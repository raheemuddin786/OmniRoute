/**
 * SPB-IR Proxy Bridge Orchestration & Zero-Loss Fallback Service
 * Coordinates intent analysis, tiered model routing, state checkpointing,
 * and autonomous zero-loss fallback recovery.
 */

import { classifyIntent, IntentProfile } from "./intentAnalyzer.ts";
import { selectModelTier, TierAssignment } from "./tieredRegistry.ts";
import { saveCheckpoint, getCheckpoint } from "../../../src/lib/db/spbState.ts";

export interface SpbRoutingContext {
  sessionId?: string;
  messages: Array<{ role: string; content?: string }>;
  tools?: unknown[];
}

export interface SpbRoutingDecision {
  intent: IntentProfile;
  tierAssignment: TierAssignment;
  checkpointRestored: boolean;
}

export async function processSmartProxyRouting(
  context: SpbRoutingContext
): Promise<SpbRoutingDecision> {
  const sessionId = context.sessionId || "default_session_" + Date.now();

  // 1. Classify intent
  const intent = classifyIntent(context.messages, context.tools);

  // 2. Select model tier
  const tierAssignment = selectModelTier(intent.taskPhase, intent.complexityScore);

  // 3. Check for existing checkpoint & state resumption
  let checkpointRestored = false;
  const existingCheckpoint = getCheckpoint(sessionId);
  if (existingCheckpoint && existingCheckpoint.promptAnchorHash === intent.promptAnchorHash) {
    checkpointRestored = true;
  }

  // 4. Save new state checkpoint
  saveCheckpoint({
    sessionId,
    promptAnchorHash: intent.promptAnchorHash,
    taskPhase: intent.taskPhase,
    modelTier: tierAssignment.tier,
    statePayload: JSON.stringify({ messagesCount: context.messages.length }),
    createdAt: Date.now(),
  });

  return {
    intent,
    tierAssignment,
    checkpointRestored,
  };
}

export function shouldTriggerZeroLossFallback(statusCode: number): boolean {
  // Trigger recovery on rate limits or transient upstream failures
  return statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}
