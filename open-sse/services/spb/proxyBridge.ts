/**
 * SPB-IR Proxy Bridge Orchestration & Zero-Loss Fallback Service (Production Hardened)
 * Coordinates intent analysis, tiered model routing, state checkpointing,
 * telemetry auditing, and autonomous zero-loss fallback recovery with full fault tolerance.
 */

import {
  classifyIntent,
  IntentProfile,
  cleanUserInstruction,
  GuidanceContract,
} from "./intentAnalyzer.ts";
import {
  selectModelTier,
  TierAssignment,
  detectAndRecoverFromStagnation,
  escalateFromStagnation,
} from "./tieredRegistry.ts";
import { getTierConfig } from "../tierResolver.ts";
import { saveCheckpoint, getCheckpoint, recordSpbTelemetry } from "../../../src/lib/db/spbState.ts";
import {
  maybeCcrReplace,
  DEFAULT_MIN_CHARS,
  RETRIEVAL_RAMP_FACTOR_DEFAULT,
  expandIncomingCcrMarkers,
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
  normalizeInterleavedSystemMessages,
  type PromptEnhancementResult,
  type NecessityCheckResult,
} from "./inboundIntelligence.ts";
import {
  evaluateResponseIntent,
  processSpbOutboundZeroLoss,
  extractResponseContent,
  verifyCodeDiffAgainstConclusion,
  extractClaimedFilesFromText,
  type ResponseEvaluationResult,
  type ExtractedResponseContent,
  type CodeDiffReviewResult,
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
  normalizeInterleavedSystemMessages,
  evaluateResponseIntent,
  processSpbOutboundZeroLoss,
  extractResponseContent,
  verifyCodeDiffAgainstConclusion,
  extractClaimedFilesFromText,
  type PromptEnhancementResult,
  type NecessityCheckResult,
  type ResponseEvaluationResult,
  type ExtractedResponseContent,
  type CodeDiffReviewResult,
  detectAndRecoverFromStagnation,
  escalateFromStagnation,
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
    // 1. Defensive payload validation & CCR ingress hydration
    const rawMessages = Array.isArray(context.messages)
      ? context.messages
      : [{ role: "user", content: String(context.messages || "") }];
    const messages = expandIncomingCcrMarkers(rawMessages, sessionId);
    const tools = Array.isArray(context.tools) ? context.tools : undefined;

    // 1b. CCR ingress offloading for intent classification only:
    // create a lightweight copy to prevent context bloat during heuristic analysis,
    // while keeping the original messages completely intact for model dispatch.
    const classificationMessages = await Promise.all(
      messages.map(async (msg) => {
        if (typeof msg.content === "string" && msg.content.length >= DEFAULT_MIN_CHARS) {
          const { text, replaced } = maybeCcrReplace(
            msg.content,
            DEFAULT_MIN_CHARS,
            sessionId,
            RETRIEVAL_RAMP_FACTOR_DEFAULT
          );
          if (replaced) {
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
                const { text, replaced } = maybeCcrReplace(
                  part.text,
                  DEFAULT_MIN_CHARS,
                  sessionId,
                  RETRIEVAL_RAMP_FACTOR_DEFAULT
                );
                if (replaced) {
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

    // 2. Classify intent with error boundary (using classification messages)
    const intent = classifyIntent(classificationMessages, tools);

    // Extract latest user content & detect structured payload format
    let lastUserIndex = -1;
    let lastUserText = "";
    let isLastUserArrayContent = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        lastUserIndex = i;
        const c = messages[i].content;
        if (typeof c === "string") {
          lastUserText = c;
        } else if (Array.isArray(c)) {
          isLastUserArrayContent = true;
          // Extract text blocks only; never stringify structured tool_result or object blocks
          const textBlocks = (c as unknown[])
            .filter(
              (p): p is { type: string; text: string } =>
                typeof p === "object" &&
                p !== null &&
                "type" in p &&
                (p as { type: unknown }).type === "text" &&
                "text" in p &&
                typeof (p as { text: unknown }).text === "string"
            )
            .map((p) => p.text);
          lastUserText = textBlocks.join("\n");
        }
        break;
      }
    }

    // 3. Check for existing checkpoint & state resumption with safe error handling
    let checkpointRestored = false;
    let existingCheckpoint = null;
    let restoredModel: string | null = null;
    try {
      existingCheckpoint = getCheckpoint(sessionId);
      if (existingCheckpoint?.guidanceContract && !intent.guidanceContract) {
        intent.guidanceContract = existingCheckpoint.guidanceContract as GuidanceContract;
      }
    } catch (dbErr) {
      console.warn(
        "[SPB Bridge] Checkpoint retrieval warning (proceeding without checkpoint):",
        dbErr
      );
    }

    // 3b. Integrated stagnation detection and recovery with unified escalation
    // Track consecutive read/inspection turns across turns. When an agent repeatedly
    // performs read-only operations (Read, Grep, Glob, cat, ls) without progressing
    // to code modification or test execution, we auto-steer to break the loop.
    let consecutiveReads: number;
    let stagnationDetected = false;
    let stagnationRecovered = false;
    let isStagnant = false;
    let autoRecoveryDirective: string | undefined;

    // Calculate consecutiveReads: increment if INSPECTION_SYNTHESIS, reset otherwise
    const priorConsecutiveReads = existingCheckpoint?.consecutiveReads ?? 0;
    if (intent.taskPhase === "INSPECTION_SYNTHESIS") {
      // Active inspection turn — increment the counter
      consecutiveReads = (priorConsecutiveReads || 0) + 1;
    } else {
      // Non-inspection turn (CODE_GENERATION, TESTING_AND_VERIFICATION, etc.) — reset
      consecutiveReads = 0;
    }

    // Detect stagnation using the unified recovery mechanism
    const stagnationRecovery = detectAndRecoverFromStagnation(
      sessionId,
      intent.taskPhase,
      consecutiveReads,
      existingCheckpoint
    );

    isStagnant = stagnationRecovery.isStagnant;
    if (isStagnant) {
      stagnationDetected = true;
      stagnationRecovered = true;

      // Apply the recovery directive and task phase changes
      if (stagnationRecovery.recoveryDirective) {
        autoRecoveryDirective = stagnationRecovery.recoveryDirective;
      }
      if (stagnationRecovery.newTaskPhase) {
        intent.taskPhase = stagnationRecovery.newTaskPhase;
      }
    }

    // Pass isToolResultTurn AND guidanceContract to enforce supervision
    // Tier 3 will require a guidanceContract for all phases
    const tierConfig = getTierConfig();
    let tierAssignment = selectModelTier(
      intent.taskPhase,
      intent.complexityScore,
      tierConfig?.tierModels,
      intent.requiresTools,
      intent.isToolResultTurn,
      intent.guidanceContract
    );

    // If stagnation recovery specified an escalation tier, enforce it immediately
    if (isStagnant && stagnationRecovery.escalationTier) {
      const resilientModels = tierConfig?.tierModels?.tier_2_resilient;
      tierAssignment = {
        tier: stagnationRecovery.escalationTier,
        recommendedModels:
          resilientModels && resilientModels.length > 0
            ? resilientModels
            : tierAssignment.recommendedModels,
        guidanceContract: tierAssignment.guidanceContract || intent.guidanceContract,
        requiresTools: intent.requiresTools,
        complexityScore: intent.complexityScore,
      };
      console.log(
        `[SPB Bridge] Session ${sessionId} | Stagnation recovery tier applied: ${tierAssignment.tier}`
      );
    }
    console.log(
      `[SPB Bridge] Session ${sessionId} | TaskPhase: ${intent.taskPhase} | Selected Tier: ${tierAssignment.tier} | GuidanceContract present: ${!!intent.guidanceContract}`
    );

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

    // Normalize guidanceContract after tier selection (ensure consistent structure)
    let normalizedGuidanceContract: GuidanceContract | undefined = undefined;
    if (tierAssignment.guidanceContract) {
      normalizedGuidanceContract = tierAssignment.guidanceContract;
    } else if (intent.guidanceContract) {
      normalizedGuidanceContract = intent.guidanceContract;
    }

    const selectedModel =
      restoredModel ||
      (tierAssignment.recommendedModels && tierAssignment.recommendedModels.length > 0
        ? tierAssignment.recommendedModels[0]
        : null);

    // 5. Synthesize or propagate guidanceContract across session turns
    let activeGuidanceContract: GuidanceContract | undefined =
      normalizedGuidanceContract ||
      (existingCheckpoint?.guidanceContract as GuidanceContract | undefined);

    if (isStagnant) {
      // Refresh GuidanceContract with anti-stagnation execution constraints
      const cleanInstruction = cleanUserInstruction(lastUserText) || "Active execution recovery";
      activeGuidanceContract = {
        supervisorTier: "tier_2_resilient",
        taskSpecification: cleanInstruction,
        constraints: [
          "EXECUTION MANDATE: You have completed sufficient inspection. Stop further read/grep/glob file inspections.",
          "Immediately perform code modification or test execution using available tools.",
          "Zero unverified assumptions — all code changes must be tool-verified",
          "Preserve existing architecture and contracts during modifications",
        ],
        instructions: [cleanInstruction],
        targetFiles: [],
        verificationCriteria: [
          "All test and verification suites must pass with zero errors",
          "No pending read-only inspection cycles remain",
        ],
        createdAt: Date.now(),
      };
      tierAssignment.guidanceContract = activeGuidanceContract;

      // Inject auto-recovery directive into the inbound prompt to override passive exploration
      autoRecoveryDirective =
        "[SPB-IR Auto-Recovery Directive: Active Execution Mandate]\n" +
        "Autonomous execution loop recovery engaged: Excessive consecutive inspection cycles detected (≥ 3 turns)." +
        "\nYou are prohibited from performing further read-only inspection calls in this turn." +
        "\nYou must directly write/edit the solution or execute verification tests immediately.";
    } else if (
      intent.taskPhase === "ARCHITECTURAL_PLANNING" ||
      (!activeGuidanceContract &&
        (tierAssignment.tier === "tier_1_apex" || tierAssignment.tier === "tier_2_resilient"))
    ) {
      const cleanInstruction =
        cleanUserInstruction(lastUserText) || "Supervised autonomous execution";
      activeGuidanceContract = {
        supervisorTier: tierAssignment.tier,
        origin: tierAssignment.tier === "tier_1_apex" ? "supervisor" : "auto",
        taskSpecification: cleanInstruction,
        constraints: [
          "Zero unverified assumptions",
          "Preserve existing architecture and contracts",
          "Execute all required tool operations autonomously without delegating commands to the user",
        ],
        instructions: [cleanInstruction],
        targetFiles: [],
        verificationCriteria: ["All test and verification suites must pass with zero errors"],
        createdAt: Date.now(),
      };
      tierAssignment.guidanceContract = activeGuidanceContract;
    }

    // 6. Save new state checkpoint asynchronously / safely
    // Include guidanceContract and stagnation tracking in checkpoint for session restore and verification loop
    try {
      saveCheckpoint({
        sessionId,
        promptAnchorHash: intent.promptAnchorHash,
        taskPhase: intent.taskPhase,
        modelTier: tierAssignment.tier,
        guidanceContract: activeGuidanceContract,
        consecutiveReads,
        stagnationRecovered: stagnationRecovered ? 1 : 0,
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

    // 7. Inbound Intelligence, Prompt Enhancement & Necessity Gate
    // Never enforce confirmation gates or overwrite structured content on tool result turns
    // or when the message consists of tool execution outputs. Doing so alters tool schemas and halts autonomous agent runs.
    const isToolTurn = intent.isToolResultTurn || (isLastUserArrayContent && !lastUserText.trim());

    const enhancement =
      !isToolTurn && lastUserText.trim()
        ? enhanceInboundPrompt(lastUserText, tierAssignment.tier, intent.taskPhase, messages)
        : undefined;

    // Avoid double-wrapping prompts that already have SPB directives or role assignments
    const isAlreadyExtensivePrompt =
      lastUserText.includes("[SPB-IR") || lastUserText.includes("[Role Directive:");

    let enhancedMessages: Array<{ role: string; content?: unknown }> | undefined;
    if (
      enhancement &&
      enhancement.enhancedPrompt !== lastUserText &&
      lastUserIndex >= 0 &&
      !isAlreadyExtensivePrompt
    ) {
      enhancedMessages = messages.map((m, idx) => {
        if (idx === lastUserIndex) {
          if (typeof m.content === "string") {
            return { ...m, content: enhancement.enhancedPrompt };
          }
          if (Array.isArray(m.content)) {
            let replacedText = false;
            const updatedContent = m.content.map((part) => {
              if (
                !replacedText &&
                part &&
                typeof part === "object" &&
                (part as Record<string, unknown>).type === "text" &&
                typeof (part as Record<string, unknown>).text === "string"
              ) {
                replacedText = true;
                return { ...part, text: enhancement.enhancedPrompt };
              }
              return part;
            });
            return { ...m, content: updatedContent };
          }
        }
        return m;
      });
    }

    // 8. Normalization of interleaved system directives for edge models
    if (tierAssignment.tier === "tier_3_local") {
      if (enhancedMessages !== undefined) {
        enhancedMessages = normalizeInterleavedSystemMessages(
          enhancedMessages as Array<{ role: string; content?: unknown }>
        );
      } else {
        const hasInterleavedSystem = messages.some(
          (m, idx) =>
            (m.role === "system" && idx > 0) ||
            (typeof m.content === "string" &&
              /^(?:SessionStart:|english-only output style is active|Attribution for git commits|You are powered by the model)/.test(
                m.content.trim()
              ))
        );
        if (hasInterleavedSystem) {
          enhancedMessages = normalizeInterleavedSystemMessages(
            messages as Array<{ role: string; content?: unknown }>
          );
        }
      }
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
        stagnationDetected,
        stagnationRecovered,
      });
      console.log(
        `[SPB Bridge Execution] Session: ${sessionId} | Turn: ${intent.isToolResultTurn ? "tool_result" : "human_prompt"} | Phase: ${intent.taskPhase} | Tier: ${tierAssignment.tier} | Stagnation: ${stagnationRecovered ? "recovered" : stagnationDetected ? "detected" : "none"} | Contract: ${activeGuidanceContract ? "present" : "none"}`
      );
    } catch (telemErr) {
      console.warn("[SPB Bridge] Telemetry recording warning:", telemErr);
    }

    // Inject auto-recovery directive into messages if stagnation was detected
    if (autoRecoveryDirective) {
      // If enhancement produced an enhanced prompt, prepend the directive
      if (enhancement && enhancement.enhancedPrompt) {
        enhancement.enhancedPrompt = `${autoRecoveryDirective}\n\n${enhancement.enhancedPrompt}`;
      } else if (lastUserIndex >= 0 && messages[lastUserIndex]) {
        // Inject directly into the last user message's content
        const targetMsg = messages[lastUserIndex];
        if (typeof targetMsg.content === "string") {
          messages[lastUserIndex] = {
            ...targetMsg,
            content: `${autoRecoveryDirective}\n\n${targetMsg.content}`,
          };
        } else if (Array.isArray(targetMsg.content)) {
          let replacedText = false;
          messages[lastUserIndex] = {
            ...targetMsg,
            content: targetMsg.content.map((part) => {
              if (
                !replacedText &&
                part &&
                typeof part === "object" &&
                (part as Record<string, unknown>).type === "text" &&
                typeof (part as Record<string, unknown>).text === "string"
              ) {
                replacedText = true;
                return { ...part, text: `${autoRecoveryDirective}\n\n${part.text}` };
              }
              return part;
            }),
          };
        }
      }
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
