/**
 * SPB-IR Proxy Bridge Orchestration & Zero-Loss Fallback Service (Production Hardened)
 * Coordinates intent analysis, tiered model routing, state checkpointing,
 * telemetry auditing, and autonomous zero-loss fallback recovery with full fault tolerance.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
  detectAndRecoverFromToolDeadlock,
  escalateFromStagnation,
  type ModelTier,
} from "./tieredRegistry.ts";
import { getTierConfig } from "../tierResolver.ts";
import { observeChangeProtocol } from "./changeProtocol/observer.ts";
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
  decomposeRequestIntoLedger,
  resolveSessionLifecycle,
  executeParallelPhase,
  executeSequentialPhase,
  type SubTask,
  type PartitionedContext,
  type VerifiedArtifactContract,
  type DecompositionResult,
} from "./contextPartition.ts";
import {
  expandLedgerWithApex,
  classifyFollowUp,
  gatherApexContext,
  type ModelDispatchFn,
} from "./apexLedger.ts";
import { containsMediaKind } from "../../utils/mediaParts.ts";
import { getResolvedModelCapabilities } from "../modelCapabilities.ts";
import {
  enhanceInboundPrompt,
  evaluateRequestNecessity,
  computePatternHash,
  normalizeInterleavedSystemMessages,
  extractContextAnchors,
  type PromptEnhancementResult,
  type NecessityCheckResult,
} from "./inboundIntelligence.ts";
import type {
  ResponseEvaluationResult,
  ExtractedResponseContent,
  CodeDiffReviewResult,
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
  spbProfile?: string;
  workspaceRoot?: string;
  dispatchModel?: ModelDispatchFn;
  apiKeyId?: string | null;
}

export interface SpbRoutingDecision {
  intent: IntentProfile;
  tierAssignment: TierAssignment;
  selectedModel: string | null;
  checkpointRestored: boolean;
  guidanceContract?: GuidanceContract;
  enhancement?: PromptEnhancementResult;
  necessity?: NecessityCheckResult;
  enhancedMessages?: Array<{ role: string; content?: unknown }>;
  cacheControl?: { type: "ephemeral" };
  tokensSaved?: number;
  originalPrompt?: string;
  error?: string;
}

const mtimeCache = new Map<string, { size: number; mtime: number; hash: string }>();

export function snapshotWorkingTreeDirtyFiles(cwd?: string): {
  files: string[];
  hashes: Record<string, string>;
  stats: Record<string, { size: number; mtime: number; hash: string }>;
} {
  const targetCwd = cwd || process.env.UPSTREAM_CWD || process.cwd();
  const files: string[] = [];
  const hashes: Record<string, string> = {};
  const stats: Record<string, { size: number; mtime: number; hash: string }> = {};
  const MAX_HASH_FILES = 100;
  const MAX_HASH_BYTES = 2 * 1024 * 1024; // 2MB cap
  try {
    const res = spawnSync("git", ["status", "--porcelain=v1", "-uall", "-z"], {
      cwd: targetCwd,
      encoding: "utf8",
      timeout: 3000,
    });
    if (res.status === 0 && res.stdout) {
      const tokens = res.stdout.split("\0");
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token) continue;
        const code = token.slice(0, 2);
        const filePart = token.slice(3).trim();
        if (code.includes("R") || code.includes("C")) {
          if (filePart) files.push(filePart);
          const orig = tokens[++i];
          if (orig) files.push(orig);
        } else if (filePart) {
          files.push(filePart);
        }
      }
      for (let i = 0; i < Math.min(files.length, MAX_HASH_FILES); i++) {
        const f = files[i];
        try {
          const abs = path.isAbsolute(f) ? f : path.resolve(targetCwd, f);
          if (fs.existsSync(abs)) {
            const st = fs.statSync(abs);
            if (st.isFile()) {
              const cached = mtimeCache.get(abs);
              if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
                hashes[f] = cached.hash;
                stats[f] = cached;
                continue;
              }

              let hash = "";
              if (st.size <= MAX_HASH_BYTES) {
                hash = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
              } else {
                // For large files, hash header + metadata
                const fd = fs.openSync(abs, "r");
                const buf = Buffer.alloc(64 * 1024);
                const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
                fs.closeSync(fd);
                hash = crypto
                  .createHash("sha256")
                  .update(`${st.size}:${st.mtimeMs}:`)
                  .update(buf.subarray(0, bytesRead))
                  .digest("hex");
              }
              hashes[f] = hash;
              const entry = { size: st.size, mtime: st.mtimeMs, hash };
              stats[f] = entry;
              mtimeCache.set(abs, entry);
            }
          }
        } catch {
          // Non-blocking hash capture
        }
      }
    }
  } catch {
    // Non-blocking fallback
  }
  return { files, hashes, stats };
}

export function snapshotRegressionBaseline(cwd?: string): {
  testCommandDetected: string | null;
  testsPassing: boolean | null;
} {
  const targetCwd = cwd || process.env.UPSTREAM_CWD || process.cwd();
  try {
    const pkgPath = path.resolve(targetCwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.scripts?.test) {
        // Quick non-blocking baseline test probe
        const res = spawnSync("npm", ["test", "--", "--run", "--testTimeout=2000"], {
          cwd: targetCwd,
          encoding: "utf8",
          timeout: 4000,
        });
        return {
          testCommandDetected: "npm test",
          testsPassing: res.status === 0,
        };
      }
    }
  } catch {
    // Non-blocking fallback
  }
  return { testCommandDetected: null, testsPassing: null };
}

export async function processSmartProxyRouting(
  context: SpbRoutingContext
): Promise<SpbRoutingDecision> {
  const startTime = Date.now();
  const sessionId = context.sessionId || "default_session_" + Date.now();
  let existingCheckpoint: ReturnType<typeof getCheckpoint> = null;

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

    // 3. Resolve tier configuration & check for existing checkpoint
    const tierConfig = getTierConfig(context.spbProfile);
    let autoRecoveryDirective: string | undefined;
    let checkpointRestored = false;
    let restoredModel: string | null = null;
    try {
      existingCheckpoint = getCheckpoint(sessionId);
      // Gap 5: Re-hydrate ledger intents after context compaction.
      // When context compaction fires, the in-memory guidanceContract.intents array can be
      // dropped from the message payload.  The persisted SQLite checkpoint still contains the
      // original intents.  If the restored contract has an empty intents array while the
      // checkpoint carried a populated one, copy them back so the ledger judge can run.
      if (
        existingCheckpoint?.guidanceContract &&
        (existingCheckpoint.guidanceContract as GuidanceContract).intents?.length === 0
      ) {
        // The checkpoint itself IS the SQLite record — if intents are absent here it means
        // they were never persisted (a first turn), which is handled downstream normally.
        // We log the mismatch for observability without blocking.
        console.warn(
          `[SPB Bridge] Session ${sessionId} | Checkpoint intents empty — possible compaction drop; keeping contract as-is for downstream re-decomposition.`
        );
      }
      if (existingCheckpoint?.guidanceContract && !intent.guidanceContract) {
        const existing = existingCheckpoint.guidanceContract as GuidanceContract;
        const mode = tierConfig?.spbConfig?.intentLedgerMode ?? "off";

        // Operator Fix 2: Only real user messages may trigger follow-up classification; tool-result turns never do.
        const isToolTurn =
          intent.isToolResultTurn ||
          (Array.isArray(messages) &&
            messages.length > 0 &&
            messages[messages.length - 1]?.role === "tool");

        if (isToolTurn) {
          // Tool-result turns strictly retain the existing guidance contract without running follow-up classification
          intent.guidanceContract = existing;
        } else if (
          (mode === "apex_guided" || mode === "apex_shadow") &&
          typeof context.dispatchModel === "function"
        ) {
          const followUp = await classifyFollowUp(existing, lastUserText, context.dispatchModel, {
            maxItems: tierConfig?.spbConfig?.maxLedgerItems ?? 8,
          });

          // Reject smaller or generic replacement ledgers and log operation ledger_downgrade_rejected
          const existingCount = existing.intents?.length ?? 0;
          const newCount = followUp.ledger?.length ?? 0;
          const isGenericCollapse =
            newCount === 1 && existingCount > 1 && followUp.relation !== "new_task";
          const isDowngrade =
            existingCount > 0 &&
            (newCount < existingCount || isGenericCollapse) &&
            followUp.relation !== "new_task";

          if (isDowngrade) {
            try {
              recordSpbTelemetry({
                sessionId,
                taskPhase: intent.taskPhase,
                modelTier: "tier_1_apex",
                checkpointRestored: true,
                fallbackTriggered: true,
                statusCode: 200,
                latencyMs: 0,
                timestamp: Date.now(),
                spbProfile: context.spbProfile || "default",
                operation: "ledger_downgrade_rejected",
                fallbackReason: `Rejected follow-up collapse: attempted to replace ${existingCount} active items with ${newCount} items during ${followUp.relation}`,
              });
            } catch {
              // Non-blocking telemetry
            }
            intent.guidanceContract = existing;
          } else {
            intent.guidanceContract = {
              ...existing,
              intents: followUp.ledger,
            };
            if (followUp.directive && mode === "apex_guided") {
              autoRecoveryDirective = autoRecoveryDirective
                ? `${autoRecoveryDirective}\n\n${followUp.directive}`
                : followUp.directive;
            }
          }
        } else {
          const resolution = resolveSessionLifecycle(
            existing,
            lastUserText,
            tierConfig?.spbConfig?.maxLedgerItems ?? 8
          );
          intent.guidanceContract = resolution.contract;
          if (resolution.directive && mode !== "apex_shadow") {
            autoRecoveryDirective = autoRecoveryDirective
              ? `${autoRecoveryDirective}\n\n${resolution.directive}`
              : resolution.directive;
          }
        }
      }
    } catch (dbErr) {
      console.warn(
        "[SPB Bridge] Checkpoint retrieval warning (proceeding without checkpoint):",
        dbErr
      );
    }

    // 3b. Integrated stagnation detection and recovery with unified escalation
    // Track cumulative inspection turns across phase changes. When an agent repeatedly
    // performs read-only operations (Read, Grep, Glob, cat, ls) without progressing
    // to code modification or test execution, we auto-steer to break the loop.
    //
    // KEY FIX: Use cumulative inspection counter that only resets on CODE MUTATION,
    // not on phase changes. This prevents oscillation loops between INSPECTION_SYNTHESIS
    // and TESTING_AND_VERIFICATION phases.
    let consecutiveReads: number;
    let stagnationDetected = false;
    let stagnationRecovered = false;
    let isStagnant = false;

    // Calculate cumulative non-mutating turn counter and elapsed time since last mutation:
    // Any turn that does NOT mutate code increments consecutiveReads.
    // Specifically:
    // 1. Read-only tool results (Read, Grep, Glob, Bash inspection) increment, regardless of taskPhase
    // 2. Inspection phases (INSPECTION_SYNTHESIS, DETERMINISTIC_ROUTING, TESTING_AND_VERIFICATION) increment
    // 3. Only an actual code mutation tool result resets the counter to 0 and records lastMutationTime.
    const now = Date.now();
    const priorConsecutiveReads = existingCheckpoint?.consecutiveReads ?? 0;
    const _priorStagnationRecovered = existingCheckpoint?.stagnationRecovered ?? false;
    const isNonMutatingToolResult = intent.isToolResultTurn && !intent.isCodeMutationToolResult;

    // Parse existing checkpoint statePayload to retrieve lastMutationTime and lastPeriodicPromptTime
    let parsedStatePayload: Record<string, unknown> = {};
    try {
      if (existingCheckpoint?.statePayload) {
        parsedStatePayload = JSON.parse(existingCheckpoint.statePayload);
      }
    } catch {
      parsedStatePayload = {};
    }

    const lastMutationTime =
      typeof parsedStatePayload.lastMutationTime === "number"
        ? (parsedStatePayload.lastMutationTime as number)
        : (existingCheckpoint?.createdAt ?? now);
    const lastPeriodicPromptTime =
      typeof parsedStatePayload.lastPeriodicPromptTime === "number"
        ? (parsedStatePayload.lastPeriodicPromptTime as number)
        : 0;
    const priorConsecutiveToolFailures =
      typeof parsedStatePayload.consecutiveToolFailures === "number"
        ? (parsedStatePayload.consecutiveToolFailures as number)
        : 0;

    let updatedLastMutationTime = lastMutationTime;

    // Visual crash inspection or active diagnostic error turns should NOT count as passive stagnation.
    // When the agent is diagnosing a crash screenshot, test failure, or stack trace, it must be granted
    // diagnostic latitude to inspect the relevant error line or visual artifact before editing code blindly.
    const isDiagnosticOrVisualTurn = Boolean(
      intent.hasVisualOrCrashData ||
      intent.hasTestOrDiagnosticFailure ||
      intent.isToolExecutionError
    );

    const _isInspectionPhase =
      intent.taskPhase === "INSPECTION_SYNTHESIS" ||
      intent.taskPhase === "DETERMINISTIC_ROUTING" ||
      (intent.taskPhase === "TESTING_AND_VERIFICATION" && !isDiagnosticOrVisualTurn);

    // Gap 4: Only reset stagnation on genuine short continuation messages, not on frustrated
    // corrections that happen to include "ok" or "yes" mid-sentence.
    // The pattern must be the ENTIRETY (or near-entirety) of the message — not buried in prose.
    const lastUserTrimmed = lastUserText.trim();
    const isContinuationResume =
      (lastUserTrimmed.length <= 50 &&
        /^(?:ok|yes|proceed|continue|carry on|go ahead|sure|fine|yep|done|next|compact)(?:\s+(?:please|next|now|with that|further|ahead|with changes|thanks|thank you))?[\s!.]*$/i.test(
          lastUserTrimmed
        )) ||
      (Number(parsedStatePayload.messagesCount ?? 0) > 100 && (priorConsecutiveReads ?? 0) === 0);

    if (isContinuationResume) {
      // Session continuation / resume: reset read counter so a fresh inspection cycle begins
      consecutiveReads = 0;
    } else if (intent.isToolResultTurn && intent.isCodeMutationToolResult) {
      // Confirmed code mutation: reset counter and update lastMutationTime
      consecutiveReads = 0;
      updatedLastMutationTime = now;
    } else if (isDiagnosticOrVisualTurn) {
      // Diagnostic turn inspecting failure or visual crash output: preserve counter without incrementing
      consecutiveReads = priorConsecutiveReads || 0;
    } else if (isNonMutatingToolResult) {
      // Only passive non-mutating tool execution accumulates stagnation, not user prompt turns
      consecutiveReads = (priorConsecutiveReads || 0) + 1;
    } else {
      // Direct human instruction turns preserve the prior counter
      consecutiveReads = priorConsecutiveReads || 0;
    }

    const elapsedSinceLastMutationMs = now - updatedLastMutationTime;

    // Detect stagnation using the unified recovery mechanism
    const stagnationRecovery = detectAndRecoverFromStagnation(
      sessionId,
      intent.taskPhase,
      consecutiveReads,
      existingCheckpoint
        ? {
            consecutiveReads,
            modelTier: existingCheckpoint.modelTier,
            guidanceContract: existingCheckpoint.guidanceContract as GuidanceContract | undefined,
            lastMutationTime: updatedLastMutationTime,
            lastPeriodicPromptTime,
            stagnationRecovered: Boolean(existingCheckpoint.stagnationRecovered),
          }
        : {
            consecutiveReads,
            lastMutationTime: updatedLastMutationTime,
            lastPeriodicPromptTime,
          },
      {
        elapsedSinceLastMutationMs,
      }
    );
    // tieredRegistry now returns reset counter + stagnationRecovered flag + updatedCheckpoint
    isStagnant = stagnationRecovery.isStagnant;
    // Use updated checkpoint for saving (contains reset consecutiveReads and stagnationRecovered flag)
    const updatedCheckpoint = stagnationRecovery.updatedCheckpoint;
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

    // Detect and recover from repeated tool execution deadlock (e.g. 2+ failing edits or invalid payloads)
    const toolDeadlockRecovery = detectAndRecoverFromToolDeadlock(
      intent.toolFailureDiagnostic,
      priorConsecutiveToolFailures,
      intent.taskPhase
    );
    const updatedConsecutiveToolFailures = toolDeadlockRecovery.updatedConsecutiveFailures;

    if (toolDeadlockRecovery.isDeadlocked && toolDeadlockRecovery.correctiveDirective) {
      isStagnant = true;
      stagnationDetected = true;
      stagnationRecovered = true;
      autoRecoveryDirective = autoRecoveryDirective
        ? `${toolDeadlockRecovery.correctiveDirective}\n\n${autoRecoveryDirective}`
        : toolDeadlockRecovery.correctiveDirective;
      if (toolDeadlockRecovery.newTaskPhase) {
        intent.taskPhase = toolDeadlockRecovery.newTaskPhase;
      }
    } else if (intent.isToolExecutionError) {
      // Single/first-time tool execution error: provide targeted diagnostic guidance
      const toolDiagnosticDirective =
        "[SPB Diagnostic Guidance: A tool operation reported a failure or error output. " +
        "Examine the exact error message, verify file paths and permissions, and address the root cause directly before executing further actions. " +
        "Do not assume nonexistent contents or repeat the same failing command without modification.]";
      autoRecoveryDirective = autoRecoveryDirective
        ? `${toolDiagnosticDirective}\n\n${autoRecoveryDirective}`
        : toolDiagnosticDirective;
    }

    // Hard Duplicate File Read Blocker:
    // If the agent read the exact same file >= duplicateReadThreshold times within the recent window,
    // inject diagnostic guidance without latching permanent false stagnation
    if (intent.isDuplicateFileRead && intent.duplicateFilePath) {
      const duplicateBlockDirective = intent.isToolExecutionError
        ? `[SPB Diagnostic Guidance: A tool operation on '${intent.duplicateFilePath}' failed. Verify the file path, request workspace access if needed, or diagnose the underlying error before proceeding. Do not assume file contents or hallucinate.]`
        : intent.taskPhase === "ARCHITECTURAL_PLANNING"
          ? `[SPB Guidance: The file '${intent.duplicateFilePath}' has already been inspected multiple times. Repository context has been acquired. Formulate the comprehensive SDLC plan and task checklist now.]`
          : `[SPB Guidance: The file '${intent.duplicateFilePath}' has already been inspected multiple times. Context from this file has been acquired. Proceed to applying edits (Write/Edit) or executing tests.]`;
      autoRecoveryDirective = autoRecoveryDirective
        ? `${autoRecoveryDirective}\n\n${duplicateBlockDirective}`
        : duplicateBlockDirective;
    }

    // Hard Duplicate Search / Grep Loop Blocker:
    // If the agent searched/grepped for the same query/pattern >= duplicateReadThreshold times,
    // inject explicit guidance to stop repeated searches and draw actionable conclusions.
    if (intent.isDuplicateSearch && intent.duplicateSearchQuery) {
      const duplicateSearchDirective =
        `[SPB Search Loop Breaker: The search/grep query '${intent.duplicateSearchQuery}' has already been executed repeatedly. ` +
        `Search context is acquired. If results were empty, conclude the string is NOT present in the codebase. ` +
        `Do not run repeated variations of grep/find/cat. Proceed immediately to direct implementation or plan formulation.]`;
      autoRecoveryDirective = autoRecoveryDirective
        ? `${autoRecoveryDirective}\n\n${duplicateSearchDirective}`
        : duplicateSearchDirective;
    }

    // Hard Polling Loop Breaker:
    // If the agent has been repeatedly polling background test processes, checking ps/pgrep/grep/wc,
    // or repeating polling stagnation remarks, inject an explicit termination directive and command execution.
    if (intent.isPollingLoopDetected) {
      const antiPollingDirective =
        "[Anti-Polling Directive: Terminate background status polling immediately. " +
        "Do not run ps, pgrep, wc -l, or wait commands to monitor background processes. " +
        "Proceed immediately to execute the primary task by applying required file modifications and code changes (Write/Edit/Bash).]";
      autoRecoveryDirective = autoRecoveryDirective
        ? `${autoRecoveryDirective}\n\n${antiPollingDirective}`
        : antiPollingDirective;
    }

    // Pass isToolResultTurn AND guidanceContract to enforce supervision
    // Tier 3 will require a guidanceContract for all phases
    let tierAssignment = selectModelTier(
      intent.taskPhase,
      intent.complexityScore,
      tierConfig?.tierModels,
      intent.requiresTools,
      intent.isToolResultTurn,
      intent.guidanceContract,
      context.spbProfile
    );

    // If stagnation recovery specified an escalation tier, enforce it immediately
    if (isStagnant && stagnationRecovery.escalationTier) {
      const targetTierKey =
        stagnationRecovery.escalationTier === "tier_1_apex"
          ? "apex"
          : stagnationRecovery.escalationTier === "tier_3_local"
            ? "local"
            : "resilient";

      const tierModels =
        tierConfig?.tierModels?.[targetTierKey] ||
        (tierConfig?.tierModels as unknown as Record<string, string[]> | undefined)?.[
          stagnationRecovery.escalationTier
        ];
      tierAssignment = {
        tier: stagnationRecovery.escalationTier,
        recommendedModels:
          tierModels && tierModels.length > 0 ? tierModels : tierAssignment.recommendedModels,
        maxTokens: tierAssignment.maxTokens,
        temperature: tierAssignment.temperature,
        cacheEnabled: tierAssignment.cacheEnabled,
        reasoningEffort: tierAssignment.reasoningEffort,
        guidanceContract: tierAssignment.guidanceContract || intent.guidanceContract,
        requiresGuidance: tierAssignment.requiresGuidance,
      };
      console.log(
        `[SPB Bridge] Session ${sessionId} | Stagnation recovery tier applied: ${tierAssignment.tier} (models: ${tierAssignment.recommendedModels?.join(", ")})`
      );
    }
    console.log(
      `[SPB Bridge] Session ${sessionId} | TaskPhase: ${intent.taskPhase} | Selected Tier: ${tierAssignment.tier} | GuidanceContract present: ${!!intent.guidanceContract}`
    );

    if (existingCheckpoint) {
      // Model continuity: preserve model continuity when the active turn is within the same tier
      // or when the prompt anchor hash matches.
      // ALSO allow cross-tier restoration when the prior checkpoint achieved satisfactory results
      // or when continuing an established session checkpoint across escalation boundaries.
      const priorSatisfaction = existingCheckpoint.statePayload
        ? (() => {
            try {
              const parsed = JSON.parse(existingCheckpoint.statePayload);
              return typeof parsed.satisfactionScore === "number" ? parsed.satisfactionScore : null;
            } catch {
              return null;
            }
          })()
        : null;

      const sameAnchor = existingCheckpoint.promptAnchorHash === intent.promptAnchorHash;
      const sameTier = existingCheckpoint.modelTier === tierAssignment.tier;
      const highSatisfactionCrossTier = priorSatisfaction !== null && priorSatisfaction >= 0.8;

      if ((sameAnchor && sameTier) || highSatisfactionCrossTier) {
        checkpointRestored = sameTier || (priorSatisfaction !== null && priorSatisfaction >= 0.8);
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
        if (highSatisfactionCrossTier && !sameTier) {
          console.log(
            `[SPB Bridge] Session ${sessionId} | Cross-tier checkpoint restored (prior satisfaction: ${priorSatisfaction ?? "baseline"}, prior tier: ${existingCheckpoint.modelTier}, current tier: ${tierAssignment.tier})`
          );
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

    // When request contains images, filter candidates to ensure native vision capability
    const payloadHasImages = containsMediaKind(
      context.messages as Parameters<typeof containsMediaKind>[0],
      "image"
    );
    if (payloadHasImages && tierAssignment.recommendedModels?.length) {
      const visionCompatible = tierAssignment.recommendedModels.filter((modelStr) => {
        const caps = getResolvedModelCapabilities(modelStr);
        return caps.supportsVision === true;
      });
      if (visionCompatible.length > 0) {
        tierAssignment.recommendedModels = visionCompatible;
      }
    }

    // When stagnant, do not reuse restoredModel if it is the model that became stagnant;
    // rotate or alternate models within the tier if multiple models are configured.
    let selectedModel = restoredModel;
    if (
      isStagnant &&
      restoredModel &&
      tierAssignment.recommendedModels &&
      tierAssignment.recommendedModels.length > 1
    ) {
      const alternate = tierAssignment.recommendedModels.find((m) => m !== restoredModel);
      if (alternate) {
        selectedModel = alternate;
        console.log(
          `[SPB Bridge] Session ${sessionId} | Stagnation model rotated from ${restoredModel} to ${selectedModel}`
        );
      }
    } else if (
      payloadHasImages &&
      selectedModel &&
      getResolvedModelCapabilities(selectedModel).supportsVision !== true
    ) {
      // If the restoredModel lacks vision support, rotate to a vision-compatible model in the tier
      const visionCandidate = tierAssignment.recommendedModels?.find(
        (m) => getResolvedModelCapabilities(m).supportsVision === true
      );
      selectedModel = visionCandidate || tierAssignment.recommendedModels?.[0] || null;
    } else if (!selectedModel) {
      selectedModel =
        tierAssignment.recommendedModels && tierAssignment.recommendedModels.length > 0
          ? tierAssignment.recommendedModels[0]
          : null;
    }

    // 5. Synthesize or propagate guidanceContract across session turns
    let activeGuidanceContract: GuidanceContract | undefined =
      normalizedGuidanceContract ||
      (existingCheckpoint?.guidanceContract as GuidanceContract | undefined);

    // Root instruction preservation: extract the root task from the initial prompt or prior checkpoint
    // to prevent intermediate tool results or short turns from overwriting the composite multi-goal instruction.
    const rootTaskSpecification =
      (existingCheckpoint?.guidanceContract as GuidanceContract | undefined)?.taskSpecification ||
      (intent.originalPrompt ? cleanUserInstruction(intent.originalPrompt) : "") ||
      cleanUserInstruction(lastUserText) ||
      "Supervised autonomous execution";

    const priorInstructions =
      (existingCheckpoint?.guidanceContract as GuidanceContract | undefined)?.instructions || [];

    if (isStagnant) {
      // Refresh GuidanceContract with anti-stagnation execution constraints while preserving root task
      const cleanInstruction = cleanUserInstruction(lastUserText) || "Active execution recovery";
      const mergedInstructions = Array.from(
        new Set([...priorInstructions, rootTaskSpecification, cleanInstruction].filter(Boolean))
      );
      const anchors = extractContextAnchors(messages);
      const priorTargetFiles =
        (existingCheckpoint?.guidanceContract as GuidanceContract | undefined)?.targetFiles || [];
      const combinedTargetFiles = Array.from(
        new Set([...priorTargetFiles, ...anchors.referencedFiles].filter(Boolean))
      );

      const isPlanningPhase = intent.taskPhase === "ARCHITECTURAL_PLANNING";
      activeGuidanceContract = {
        supervisorTier: isPlanningPhase ? "tier_1_apex" : "tier_2_resilient",
        taskSpecification: rootTaskSpecification,
        intents:
          (existingCheckpoint?.guidanceContract as GuidanceContract | undefined)?.intents ||
          normalizedGuidanceContract?.intents,
        constraints: isPlanningPhase
          ? [
              "Formulate comprehensive SDLC plan with structured milestones",
              "Include explicit task checklist: requirements, architecture, files, tests, verification",
              "Zero unverified assumptions — plan must be grounded in actual repo structure",
              "Preserve existing architecture and contracts",
            ]
          : [
              "Exploration checkpoint reached: prioritize implementation or verification steps.",
              "Proceed to code modification or test execution using available tools.",
              "Zero unverified assumptions — all code changes must be tool-verified",
              "Preserve existing architecture and contracts during modifications",
            ],
        instructions: mergedInstructions,
        targetFiles: combinedTargetFiles,
        verificationCriteria: [
          "All test and verification suites must pass with zero errors",
          "No pending read-only inspection cycles remain",
        ],
        createdAt: Date.now(),
      };
      tierAssignment.guidanceContract = activeGuidanceContract;

      // Inject targeted resume directive rather than restarting task execution
      const targetSummary =
        combinedTargetFiles.length > 0
          ? `Target files: ${combinedTargetFiles.slice(0, 3).join(", ")}. `
          : "";
      const stagnationRecoveryDirective = isPlanningPhase
        ? "[Auto-Recovery Directive: SDLC PLANNING GUIDANCE]\n" +
          `Exploration checkpoint reached. ${targetSummary}` +
          "Formulate a structured, end-to-end SDLC plan with an explicit checklist covering requirements, architecture, implementation files, automated tests, and verification steps."
        : "[Auto-Recovery Directive: AUTONOMOUS IMPLEMENTATION & VERIFICATION]\n" +
          `Exploration checkpoint reached. ${targetSummary}` +
          "Proceed directly with autonomous tool execution to implement, test, and verify the required modifications. " +
          "Do not halt execution to output conversational plans, summaries, or confirmation requests. Apply all modifications directly using available tools.";
      autoRecoveryDirective = autoRecoveryDirective
        ? `${autoRecoveryDirective}\n\n${stagnationRecoveryDirective}`
        : stagnationRecoveryDirective;
    } else if (
      (intent.taskPhase === "ARCHITECTURAL_PLANNING" && !activeGuidanceContract) ||
      (!activeGuidanceContract &&
        (tierAssignment.tier === "tier_1_apex" || tierAssignment.tier === "tier_2_resilient"))
    ) {
      const cleanInstruction =
        cleanUserInstruction(lastUserText) ||
        rootTaskSpecification ||
        "Supervised autonomous execution";
      const anchors = extractContextAnchors(messages);
      const isAutonomousSdlc =
        /\b(sdlc|end-to-end autonomous|full autonomous|single prompt.*full|single execution.*single prompt|autonomous-executor|requirements.*architecture.*implementation.*testing)\b/i.test(
          cleanInstruction
        ) ||
        /\b(sdlc|end-to-end autonomous|full autonomous|single prompt.*full|single execution.*single prompt|autonomous-executor|requirements.*architecture.*implementation.*testing)\b/i.test(
          rootTaskSpecification
        );

      const mergedInstructions = Array.from(
        new Set([...priorInstructions, rootTaskSpecification, cleanInstruction].filter(Boolean))
      );

      activeGuidanceContract = {
        supervisorTier: tierAssignment.tier,
        origin: tierAssignment.tier === "tier_1_apex" ? "supervisor" : "auto",
        taskSpecification: rootTaskSpecification,
        constraints: [
          "Zero unverified assumptions",
          "Preserve existing architecture and contracts",
          "Execute all required tool operations autonomously without delegating commands to the user",
          ...(isAutonomousSdlc
            ? [
                "Execute complete SDLC cycle autonomously: research -> architecture -> implementation -> test -> local verify -> deploy -> cloud verify -> stabilize",
                "Do not halt for human confirmation between SDLC phases",
                "Zero placeholders, mocks, or hardcoding",
              ]
            : []),
        ],
        instructions: mergedInstructions,
        targetFiles:
          anchors.referencedFiles.length > 0
            ? anchors.referencedFiles
            : (existingCheckpoint?.guidanceContract as GuidanceContract | undefined)?.targetFiles ||
              [],
        verificationCriteria: [
          "All test and verification suites must pass with zero errors",
          ...(isAutonomousSdlc
            ? [
                "Local tests and quality checks pass",
                "Cloud deployment verified with live health check",
                "All side effects stabilized",
              ]
            : []),
          ...(anchors.diagnosedErrors.length > 0
            ? [`Remediate diagnosed error: ${anchors.diagnosedErrors[0]}`]
            : []),
        ],
        createdAt: Date.now(),
      };
      tierAssignment.guidanceContract = activeGuidanceContract;
    }

    // Tier 3 (local) execution ALWAYS requires GuidanceContract from supervisor tier
    // Per architecture: Tier 3 (FAST_REFACTOR, DETERMINISTIC_ROUTING, INSPECTION_SYNTHESIS)
    // must have GuidanceContract from Tier 1/2 supervisor
    if (!activeGuidanceContract && tierAssignment.tier === "tier_3_local") {
      const cleanInstruction = cleanUserInstruction(lastUserText) || "Tier 3 execution";
      const mergedInstructions = Array.from(
        new Set([...priorInstructions, rootTaskSpecification, cleanInstruction].filter(Boolean))
      );
      activeGuidanceContract = {
        supervisorTier: "tier_2_resilient",
        taskSpecification: rootTaskSpecification,
        constraints: [
          "Tier 3 execution under Tier 2 supervision",
          "Proceed with deterministic/refactor/inspection tasks using available tools",
          "All changes must be verified against existing tests and contracts",
        ],
        instructions: mergedInstructions,
        targetFiles:
          (existingCheckpoint?.guidanceContract as GuidanceContract | undefined)?.targetFiles || [],
        verificationCriteria: [
          "All test and verification suites must pass with zero errors",
          "No architectural changes without Tier 1/2 approval",
        ],
        createdAt: Date.now(),
      };
      tierAssignment.guidanceContract = activeGuidanceContract;
    }

    // Ensure active guidance contract has an initialized Intent Ledger
    if (activeGuidanceContract) {
      if (
        !Array.isArray(activeGuidanceContract.intents) ||
        activeGuidanceContract.intents.length === 0
      ) {
        // Operator Fix 2: Never initiate initial expansion on a tool-result turn
        const isToolTurn =
          intent.isToolResultTurn ||
          (Array.isArray(messages) &&
            messages.length > 0 &&
            messages[messages.length - 1]?.role === "tool");

        if (!isToolTurn) {
          const mode = tierConfig?.spbConfig?.intentLedgerMode || "off";
          if (
            (mode === "apex_guided" || mode === "apex_shadow") &&
            typeof context.dispatchModel === "function"
          ) {
            const apexCtx = gatherApexContext({
              workspaceRoot: context.workspaceRoot,
              prompt: lastUserText || rootTaskSpecification,
              conversationMessages: messages,
            });
            const expansion = await expandLedgerWithApex(
              lastUserText || rootTaskSpecification,
              apexCtx,
              context.dispatchModel,
              {
                maxItems: tierConfig?.spbConfig?.maxLedgerItems ?? 8,
                promptAnchorHash: intent.promptAnchorHash,
                tier: tierAssignment.tier,
                sessionId,
                profile: context.spbProfile,
              }
            );
            activeGuidanceContract.intents = expansion.intents;
            activeGuidanceContract.nonGoals = expansion.nonGoals;
            activeGuidanceContract.contextSource = expansion.contextSource;
          } else if (
            mode === "heuristic" ||
            mode === "apex_guided" ||
            mode === "apex_shadow" ||
            intent.complexityScore >= 0.6
          ) {
            activeGuidanceContract.intents = decomposeRequestIntoLedger(
              lastUserText || rootTaskSpecification,
              tierConfig?.spbConfig?.maxLedgerItems ?? 8
            );
          }
        }
      }
      activeGuidanceContract.strictCompletion = tierConfig?.spbConfig?.strictCompletion ?? false;
      // Gap 2: Promote strict ledger verification for multi-intent execution-mandate sessions.
      // When the user has explicitly requested both code generation and test execution (compound SDLC mandate),
      // the judge must run in strict mode so false completion claims are caught by evaluateLedgerCompletion().
      const isExecutionMandateSession =
        (intent.taskPhase === "CODE_GENERATION" ||
          intent.taskPhase === "TESTING_AND_VERIFICATION") &&
        (activeGuidanceContract.intents?.filter((i) => i.kind === "explicit").length ?? 0) >= 2;
      if (isExecutionMandateSession) {
        activeGuidanceContract.strictCompletion = true;
      }
      if (
        !activeGuidanceContract.baselineModifiedFiles ||
        !activeGuidanceContract.baselineFileHashes
      ) {
        const baselineSnapshot = snapshotWorkingTreeDirtyFiles(context.workspaceRoot);
        activeGuidanceContract.baselineModifiedFiles = baselineSnapshot.files;
        activeGuidanceContract.baselineFileHashes = baselineSnapshot.hashes;
        activeGuidanceContract.baselineFileStats = baselineSnapshot.stats;
      }
      const testGating = tierConfig?.spbConfig?.testGatingPolicy ?? "never_unless_requested";
      const isTestExplicitlyRequested =
        /\b(run test|run the test|execute test|npm test|npm run test|vitest|playwright|verify with tests)\b/i.test(
          lastUserText
        );
      const shouldRequireTestBaseline =
        testGating === "always_enforce" ||
        (testGating === "never_unless_requested" && isTestExplicitlyRequested) ||
        (testGating === "only_for_tests" && intent.taskPhase === "TESTING_AND_VERIFICATION");

      if (
        activeGuidanceContract.baselineTestPassed === undefined &&
        tierConfig?.spbConfig?.requireTestPassBeforeDone &&
        shouldRequireTestBaseline
      ) {
        const testBaseline = snapshotRegressionBaseline(context.workspaceRoot);
        activeGuidanceContract.baselineTestPassed = testBaseline.testsPassing ?? true;
      }
      tierAssignment.guidanceContract = activeGuidanceContract;
    }

    // 6. Save new state checkpoint asynchronously / safely
    // Include guidanceContract and stagnation tracking in checkpoint for session restore and verification loop
    // Satisfaction score will be updated later by applySpbOutboundZeroLoss via updateCheckpointSatisfaction
    try {
      saveCheckpoint({
        sessionId,
        promptAnchorHash: intent.promptAnchorHash,
        taskPhase: intent.taskPhase,
        modelTier: tierAssignment.tier,
        guidanceContract: activeGuidanceContract,
        consecutiveReads:
          consecutiveReads === 0
            ? 0
            : (updatedCheckpoint?.consecutiveReads ??
              (stagnationRecovery.isStagnant ? 0 : consecutiveReads)),
        stagnationRecovered:
          updatedCheckpoint?.stagnationRecovered !== undefined
            ? updatedCheckpoint.stagnationRecovered
              ? 1
              : 0
            : stagnationRecovery.isStagnant
              ? 1
              : existingCheckpoint?.stagnationRecovered
                ? 1
                : 0,
        statePayload: JSON.stringify({
          messagesCount: messages.length,
          timestamp: Date.now(),
          modelName: selectedModel,
          lastMutationTime: updatedLastMutationTime,
          consecutiveToolFailures: updatedConsecutiveToolFailures,
          lastPeriodicPromptTime:
            updatedCheckpoint?.lastPeriodicPromptTime !== undefined
              ? updatedCheckpoint.lastPeriodicPromptTime
              : lastPeriodicPromptTime,
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

    // Durable Memory Recall: Retrieve contextual memories for the user's intent if available
    let relevantMemoriesSnippet = "";
    if (!isToolTurn && lastUserText.trim()) {
      try {
        const { getMemorySettings } = await import("../../../src/lib/memory/settings.ts");
        const { retrieveMemories } = await import("../../../src/lib/memory/retrieval.ts");
        const memSettings = await getMemorySettings().catch(() => null);
        if (memSettings?.enabled) {
          const ownerId = context.apiKeyId || "default";
          const mems = await retrieveMemories(ownerId, {
            query: lastUserText,
            workspaceRoot: context.workspaceRoot,
            maxTokens: Math.min(memSettings.maxTokens || 1000, 1500),
          }).catch(() => []);
          if (mems && mems.length > 0) {
            const memText = mems
              .slice(0, 5)
              .map((m) => `- ${m.content || m.key}`)
              .join("\n");
            relevantMemoriesSnippet = `\n\n[Persistent Project Memory & Context:\n${memText}\n]`;
          }
        }
      } catch {
        // Non-blocking memory retrieval
      }
    }

    const enhancement =
      !isToolTurn && lastUserText.trim()
        ? enhanceInboundPrompt(lastUserText, tierAssignment.tier, intent.taskPhase, messages)
        : undefined;

    if (
      enhancement &&
      relevantMemoriesSnippet &&
      !enhancement.enhancedPrompt.includes("Persistent Project Memory")
    ) {
      enhancement.enhancedPrompt = `${enhancement.enhancedPrompt}${relevantMemoriesSnippet}`;
    }

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
          ) as typeof enhancedMessages;
        }
      }
    }

    // 7. Record telemetry audit
    try {
      const ledgerMode = tierConfig?.spbConfig?.intentLedgerMode ?? "off";
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
        spbProfile: context.spbProfile || "default",
        operation:
          ledgerMode === "apex_shadow"
            ? "shadow_expansion"
            : ledgerMode === "apex_guided"
              ? "apex_expansion"
              : "routing",
        intentLedger: activeGuidanceContract?.intents
          ? JSON.stringify(activeGuidanceContract.intents)
          : undefined,
      });
      console.log(
        `[SPB Bridge Execution] Session: ${sessionId} | Turn: ${intent.isToolResultTurn ? "tool_result" : "human_prompt"} | Phase: ${intent.taskPhase} | Tier: ${tierAssignment.tier} | Stagnation: ${stagnationRecovered ? "recovered" : stagnationDetected ? "detected" : "none"} | Contract: ${activeGuidanceContract ? "present" : "none"}`
      );
    } catch (telemErr) {
      console.warn("[SPB Bridge] Telemetry recording warning:", telemErr);
    }

    // Format Intent Checklist and Scope Fence Directive for inbound prompt
    let checklistDirective: string | undefined;
    const ledgerMode = tierConfig?.spbConfig?.intentLedgerMode ?? "off";
    if (
      ledgerMode !== "apex_shadow" &&
      activeGuidanceContract?.intents &&
      activeGuidanceContract.intents.length > 0
    ) {
      const openItems = activeGuidanceContract.intents.filter(
        (it) => it.status !== "done" && it.status !== "done_unverified" && it.status !== "skipped"
      );
      const doneCount = activeGuidanceContract.intents.length - openItems.length;

      let violationsNotice = "";
      if (
        activeGuidanceContract.outOfScopeViolations &&
        activeGuidanceContract.outOfScopeViolations.length > 0
      ) {
        violationsNotice = `\n[SCOPE FENCE ALERT: Out-of-scope files touched in prior turn: ${activeGuidanceContract.outOfScopeViolations.slice(0, 3).join(", ")}. Revert or justify changes.]\n`;
      }

      if (openItems.length > 0) {
        // Operator requirement 3: Inject turn-1 directives once; later turns get a one-line status
        const isToolTurn =
          intent.isToolResultTurn ||
          (Array.isArray(messages) &&
            messages.length > 0 &&
            messages[messages.length - 1]?.role === "tool");
        const isTurn1 = !isToolTurn && !existingCheckpoint;

        const totalEstimatedMinutes = openItems.reduce(
          (sum, it) => sum + (it.estimatedMinutes ?? 3),
          0
        );
        const estTimelineNotice =
          totalEstimatedMinutes > 0 ? ` | Est. Remaining: ~${totalEstimatedMinutes}m` : "";

        if (isTurn1) {
          checklistDirective =
            `[SPB-IR Intent Checklist & Scope Fence: ${doneCount}/${activeGuidanceContract.intents.length} Complete${estTimelineNotice}]${violationsNotice}\n` +
            `Active Objectives:\n` +
            openItems
              .map(
                (it) =>
                  `- [${it.id}] (${it.layer.toUpperCase()}) [${it.kind}]: ${it.text} (Est: ~${it.estimatedMinutes ?? 3}m) | Acceptance: ${it.acceptance}`
              )
              .join("\n") +
            `\nMandatory Guidelines:\n` +
            `1. Grounding / Gap Analysis: Inspect existing repository code first. If an item already exists, note it with evidence.\n` +
            `2. Scope Fence: Confine modifications strictly to the target files required for these open items.\n` +
            `3. Completion Gate: Fulfill and verify all open checklist items before declaring completion.\n` +
            `4. Initial Inspection Directive: Report your initial assessment as [I#: exists|partial|missing] with cited evidence.\n` +
            `5. Strict Dependency Order & Step Gating: You MUST execute checklist items strictly in numbered sequence. Do NOT jump ahead to later phases (such as running tests or editing downstream files) before preceding items (e.g., creating/updating use cases, specs, or schemas) are fully implemented and verified with tangible file changes or inspection proofs. Prematurely executing tests or declaring completion before completing prerequisite checklist items is strictly prohibited.\n` +
            `6. Execution Discipline: Apply verified changes promptly and decisively without prolonged thinking loops, over-complication, or context switching. Stay focused on the active objective until fully resolved.\n` +
            `7. Character Encoding Awareness: Before any string replacement on HTML or templated files, inspect the exact byte content of the target line (e.g., grep or python3 repr print). HTML entities (e.g., &amp; vs &) and encoded characters often cause silent replacement failures. Always confirm the literal character sequence in the file before substitution.\n` +
            `\nPRE-EXECUTION MANDATE: Before invoking ANY tool, you MUST first present this full checklist to the user in your opening message. ` +
            `Include each item's ID, description, estimated duration (~Xm), and the total estimated completion time (~${totalEstimatedMinutes}m total). ` +
            `Only begin tool execution AFTER presenting the plan conversationally to the user.`;
        } else {
          // Later turns get a compact status reinforcing the immediate next objective and prohibiting jumping ahead
          const nextItem = openItems[0];
          const nextFocus = nextItem
            ? ` | Current Target: [${nextItem.id}] (${nextItem.layer.toUpperCase()}) ${nextItem.text.slice(0, 45)}`
            : "";
          checklistDirective = `[SPB Intent Ledger: ${doneCount}/${activeGuidanceContract.intents.length} Complete${estTimelineNotice}${nextFocus} | Do NOT jump ahead to later items until prerequisite items are resolved]${violationsNotice}`;
        }
      }
    }

    if (checklistDirective) {
      autoRecoveryDirective = autoRecoveryDirective
        ? `${autoRecoveryDirective}\n\n${checklistDirective}`
        : checklistDirective;
    }

    // Observe change protocol (non-blocking, log-only in observe mode)
    void observeChangeProtocol({
      sessionId,
      messages,
      isToolResultTurn: intent.isToolResultTurn,
      taskPhase: intent.taskPhase,
      spbProfile: context.spbProfile,
      injectedDirective: autoRecoveryDirective,
    });

    // Inject auto-recovery directive into messages if stagnation or ledger guidance was produced
    if (autoRecoveryDirective) {
      if (!enhancedMessages) {
        enhancedMessages = messages.map((m) => ({
          ...m,
          content: Array.isArray(m.content) ? [...m.content] : m.content,
        }));
      }

      // Check whether the latest message is an active tool execution turn
      const lastMsgIdx = enhancedMessages.length - 1;
      const lastMsg = enhancedMessages[lastMsgIdx];
      const isLatestToolTurn =
        lastMsg &&
        (lastMsg.role === "tool" ||
          (Array.isArray(lastMsg.content) &&
            lastMsg.content.some((p) => p && p.type === "tool_result")));

      if (isLatestToolTurn) {
        // On active tool turns, inject guidance directly into the latest tool message so the agent receives
        // the active execution mandate without corrupting previous user prompts or causing duplicate injections.
        if (typeof lastMsg.content === "string") {
          lastMsg.content = `${lastMsg.content}\n\n[SPB CONTEXT GUIDANCE: ${autoRecoveryDirective}]`;
        } else if (Array.isArray(lastMsg.content)) {
          lastMsg.content = [
            ...lastMsg.content,
            { type: "text", text: `[SPB CONTEXT GUIDANCE: ${autoRecoveryDirective}]` },
          ];
        }
      } else {
        // On human instruction turns, inject directive into the prompt or user message
        if (enhancement && enhancement.enhancedPrompt) {
          enhancement.enhancedPrompt = `${autoRecoveryDirective}\n\n${enhancement.enhancedPrompt}`;
        }

        if (lastUserIndex >= 0 && enhancedMessages[lastUserIndex]) {
          const targetMsg = enhancedMessages[lastUserIndex];
          if (typeof targetMsg.content === "string") {
            targetMsg.content = `${autoRecoveryDirective}\n\n${targetMsg.content}`;
          } else if (Array.isArray(targetMsg.content)) {
            const hasTextBlock = targetMsg.content.some(
              (part) =>
                part &&
                typeof part === "object" &&
                (part as Record<string, unknown>).type === "text" &&
                typeof (part as Record<string, unknown>).text === "string"
            );

            if (hasTextBlock) {
              let replacedText = false;
              targetMsg.content = targetMsg.content.map((part) => {
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
              });
            } else {
              targetMsg.content = [
                { type: "text", text: autoRecoveryDirective },
                ...targetMsg.content,
              ];
            }
          }
        }
      }
    }

    // 9. Prompt Caching Boundary Optimization & Token Conservation
    let tokensSaved = 0;
    const finalMessages = (enhancedMessages || messages) as Array<{
      role: string;
      content?: unknown;
      [key: string]: unknown;
    }>;

    if (tierAssignment.cacheEnabled) {
      // Prompt Cache Preservation & Boundary Injection
      // 1. Ensure system messages carry cache_control breakpoint
      for (const m of finalMessages) {
        if (m.role === "system") {
          if (!m.cache_control) {
            m.cache_control = { type: "ephemeral" };
          }
          if (Array.isArray(m.content) && m.content.length > 0) {
            const lastBlock = m.content[m.content.length - 1];
            if (lastBlock && typeof lastBlock === "object") {
              (lastBlock as Record<string, unknown>).cache_control = { type: "ephemeral" };
            }
          }
        }
      }

      // 2. Mark preceding turn before active user turn to freeze prefix cache
      if (lastUserIndex > 0) {
        const precedingTurn = finalMessages[lastUserIndex - 1];
        if (precedingTurn) {
          if (!precedingTurn.cache_control) {
            precedingTurn.cache_control = { type: "ephemeral" };
          }
          if (Array.isArray(precedingTurn.content) && precedingTurn.content.length > 0) {
            const lastBlock = precedingTurn.content[precedingTurn.content.length - 1];
            if (lastBlock && typeof lastBlock === "object") {
              (lastBlock as Record<string, unknown>).cache_control = { type: "ephemeral" };
            }
          }
        }
      }

      // 3. Mark last tool if present in context.tools
      if (Array.isArray(tools) && tools.length > 0) {
        const lastTool = tools[tools.length - 1];
        if (
          lastTool &&
          typeof lastTool === "object" &&
          !(lastTool as Record<string, unknown>).cache_control
        ) {
          (lastTool as Record<string, unknown>).cache_control = { type: "ephemeral" };
        }
      }
    }

    // Safe CCR token savings calculation for large message bodies (>= 1200 chars)
    for (let i = 0; i < finalMessages.length; i++) {
      const msg = finalMessages[i];
      if (typeof msg.content === "string" && msg.content.length >= 1200) {
        const { text, replaced } = maybeCcrReplace(
          msg.content,
          1200,
          sessionId,
          RETRIEVAL_RAMP_FACTOR_DEFAULT
        );
        if (replaced) {
          const originalChars = msg.content.length;
          const compressedChars = text.length;
          tokensSaved += Math.max(0, Math.floor((originalChars - compressedChars) / 4));
          msg.content = text;
        }
      }
    }

    if (finalMessages !== messages) {
      enhancedMessages = finalMessages;
    }

    return {
      intent,
      tierAssignment,
      selectedModel,
      checkpointRestored,
      guidanceContract: activeGuidanceContract,
      enhancement,
      necessity: enhancement?.necessity,
      enhancedMessages,
      cacheControl: tierAssignment.cacheEnabled ? { type: "ephemeral" } : undefined,
      tokensSaved,
      originalPrompt: intent.originalPrompt || lastUserText || undefined,
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

    const tierConfig = getTierConfig(context?.spbProfile);
    const fallbackTier = selectModelTier(
      fallbackIntent.taskPhase,
      fallbackIntent.complexityScore,
      tierConfig?.tierModels,
      undefined,
      undefined,
      undefined,
      context?.spbProfile
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
      guidanceContract: existingCheckpoint?.guidanceContract as GuidanceContract | undefined,
      error: errorMsg,
    };
  }
}

export function shouldTriggerZeroLossFallback(statusCode: number): boolean {
  // Trigger recovery on rate limits, bad requests (model-scoped rejections), credits exhaustion, gateway errors, overload, or timeouts
  const tierConfig = getTierConfig();
  const configuredCodes = tierConfig?.spbConfig?.retryStatusCodes;
  if (Array.isArray(configuredCodes) && configuredCodes.length > 0) {
    return configuredCodes.includes(statusCode);
  }

  return (
    statusCode === 400 ||
    statusCode === 402 ||
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    statusCode === 529
  );
}

/**
 * Inspects a response payload or object for corrupted tool calls.
 * Flags empty/whitespace arguments or malformed/unparseable JSON arguments.
 */
export function hasCorruptedToolCalls(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;

  // Check choices[0].message.tool_calls
  const choices = Array.isArray(p.choices) ? (p.choices as Array<Record<string, unknown>>) : [];
  const toolCalls =
    choices[0]?.message && typeof choices[0].message === "object"
      ? (choices[0].message as Record<string, unknown>).tool_calls
      : Array.isArray(p.tool_calls)
        ? p.tool_calls
        : null;

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    for (const tc of toolCalls as Array<Record<string, unknown>>) {
      const fn = tc?.function as Record<string, unknown> | undefined;
      if (fn && typeof fn.name === "string" && fn.name.trim().length > 0) {
        if (fn.arguments === undefined || fn.arguments === null) {
          return true;
        }
        if (typeof fn.arguments === "string") {
          const trimmed = fn.arguments.trim();
          if (trimmed === "") return true;
          if (
            (trimmed.startsWith("{") && !trimmed.endsWith("}")) ||
            (trimmed.startsWith("[") && !trimmed.endsWith("]"))
          ) {
            return true;
          }
          try {
            JSON.parse(trimmed);
          } catch {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Determines the next promoted failover tier in the SPB hierarchy:
 * local (tier_3) -> resilient (tier_2) -> apex (tier_1).
 */
export function getNextFailoverTier(currentTier: ModelTier | string): ModelTier {
  if (currentTier === "tier_3_local" || currentTier === "local") {
    return "tier_2_resilient";
  }
  if (currentTier === "tier_2_resilient" || currentTier === "resilient") {
    return "tier_1_apex";
  }
  return "tier_1_apex";
}
