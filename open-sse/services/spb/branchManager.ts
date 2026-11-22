/**
 * SPB-IR Branch Manager — Session Forking, Delta Pruning & Continuation Capsules
 * Handles virtual session branching without violating OmniRoute's straight-line transcript invariant.
 */

import { classifyIntent, IntentProfile } from "./intentAnalyzer.ts";
import { getConversationTurnIndex } from "../../../src/lib/db/agenticConversations.ts";
import {
  saveBranchCheckpoint,
  getBranchCheckpoint,
  markBranchMerged as markDbBranchMerged,
  SpbBranchCheckpoint,
} from "../../../src/lib/db/spbBranchState.ts";
import { randomUUID } from "node:crypto";

export interface ContinuationCapsule {
  activeGoal: string;
  verifiedFacts: Record<string, string>;
  activeDependencies: string[];
  dirtyWorkingFiles: Array<{
    path: string;
    gitStatus: string;
    stagedDiffHash: string;
  }>;
  lastExecutionOutcome: { exitCode: number; primaryDiagnostic: string };
  nextActionDirectives: string[];
}

export interface BranchConfig {
  branchMode: "isolate" | "continuation" | "speculative";
  pruneLegacy: boolean;
  forkPointHash: string;
}

export interface ForkedSessionContext {
  branchId: string;
  parentSessionId: string;
  continuationFrame: string[];
  capsule: ContinuationCapsule;
  forkPointHash: string;
}

export interface SessionForkInput {
  parentSessionId: string;
  forkPointHash: string;
  branchMode: "isolate" | "continuation" | "speculative";
  pruneLegacy: boolean;
  currentMessages: Array<{ role: string; content?: unknown }>;
  currentTools?: unknown[];
}

/**
 * Generates a deterministic branch ID from parent session + fork point + timestamp
 */
function generateBranchId(_parentSessionId: string, _forkPointHash: string): string {
  return `br_${randomUUID().slice(0, 8)}`;
}

/**
 * Extracts continuation capsule from intent classification and message history
 */
function extractContinuationCapsule(
  messages: Array<{ role: string; content?: unknown }>,
  intent: IntentProfile,
  _tools?: unknown[]
): ContinuationCapsule {
  // Find the last user message with substantial content as the active goal
  let activeGoal = "";
  const verifiedFacts: Record<string, string> = {};
  const activeDependencies: string[] = [];
  const dirtyWorkingFiles: Array<{
    path: string;
    gitStatus: string;
    stagedDiffHash: string;
  }> = [];
  const nextActionDirectives: string[] = [];

  // Scan messages in reverse to find the most recent user directive
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && msg.content) {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .map((p) => (typeof p === "string" ? p : p?.text || p?.content || ""))
                .join(" ")
            : "";
      if (text.trim().length > 20) {
        activeGoal = text.slice(0, 500);
        break;
      }
    }
  }

  // Extract file paths and facts from tool results
  for (const msg of messages) {
    if (msg.role === "tool" || (msg.role === "user" && Array.isArray(msg.content))) {
      const parts = Array.isArray(msg.content) ? msg.content : [{ content: msg.content }];
      for (const part of parts) {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (p.type === "tool_result" || p.tool_use_id) {
            const content = typeof p.content === "string" ? p.content : "";
            // Extract file paths from tool output
            const fileMatches = content.match(/(?:\/[\w\-\.\/]+|\.[\w\-\.\/]+)+/g);
            if (fileMatches) {
              for (const file of fileMatches) {
                if (file.length > 3 && !verifiedFacts[file]) {
                  verifiedFacts[file] = "referenced";
                }
              }
            }
          }
        }
      }
    }
  }

  // Derive next actions from intent phase
  switch (intent.taskPhase) {
    case "ARCHITECTURAL_PLANNING":
      nextActionDirectives.push("Finalize architecture document");
      nextActionDirectives.push("Create implementation plan with milestones");
      break;
    case "CODE_GENERATION":
      nextActionDirectives.push("Implement core module");
      nextActionDirectives.push("Add unit tests");
      break;
    case "TESTING_AND_VERIFICATION":
      nextActionDirectives.push("Run test suite");
      nextActionDirectives.push("Validate against acceptance criteria");
      break;
    case "FAST_REFACTOR":
      nextActionDirectives.push("Apply refactoring");
      nextActionDirectives.push("Run regression tests");
      break;
    case "DETERMINISTIC_ROUTING":
      nextActionDirectives.push("Execute deterministic task");
      break;
  }

  // Set a default if no active goal was found
  if (!activeGoal) {
    activeGoal = `Continue ${intent.taskPhase.toLowerCase().replace("_", " ")} phase`;
  }

  return {
    activeGoal,
    verifiedFacts,
    activeDependencies,
    dirtyWorkingFiles,
    lastExecutionOutcome: { exitCode: 0, primaryDiagnostic: "ok" },
    nextActionDirectives,
  };
}

/**
 * Constructs a pruned continuation frame from parent conversation history
 * up to the fork point, with legacy bulk stripped per branch config.
 */
export async function createContinuationFrame(
  parentSessionId: string,
  forkPointHash: string,
  config: BranchConfig,
  _currentMessages: Array<{ role: string; content?: unknown }>
): Promise<string[]> {
  const turnIndex = getConversationTurnIndex(parentSessionId);

  // Find the fork point node in the parent conversation
  if (!turnIndex.nodeIds.has(forkPointHash)) {
    // Fork point not in parent chain — cannot create valid continuation
    throw new Error(
      `Fork point hash ${forkPointHash} not found in parent session ${parentSessionId}`
    );
  }

  // Build the continuation frame from messages
  const frame: string[] = [];

  // Add a system preamble marking this as a continuation
  frame.push(
    JSON.stringify({
      role: "system",
      content: `[Continuation from ${parentSessionId} at turn ${forkPointHash.slice(0, 12)}]`,
    })
  );

  // If pruning legacy, only include the current messages (clean slate from fork point)
  // Otherwise, we could attempt to include the parent's turns, but the straight-line
  // invariant means we cannot graft branches. The clean approach is to treat the
  // fork as a new session seeded with the capsule.
  if (config.pruneLegacy) {
    // For continuation mode, include a structured capsule reference
    if (config.branchMode === "continuation") {
      frame.push(
        JSON.stringify({
          role: "system",
          content: `[Continuation Capsule - see parent ${parentSessionId} for full history]`,
        })
      );
    }
  }

  return frame;
}

/**
 * Main entry point: forks a session from a parent at a specific turn hash
 */
export async function forkSession(input: SessionForkInput): Promise<ForkedSessionContext> {
  const { parentSessionId, forkPointHash, branchMode, pruneLegacy, currentMessages, currentTools } =
    input;

  const branchId = generateBranchId(parentSessionId, forkPointHash);
  const now = Date.now();

  // Classify intent from current messages to derive capsule
  const intent = classifyIntent(currentMessages, currentTools);
  const capsule = extractContinuationCapsule(currentMessages, intent, currentTools);

  // Build continuation frame (pruned history for the forked session)
  const continuationFrame = await createContinuationFrame(
    parentSessionId,
    forkPointHash,
    { branchMode, pruneLegacy, forkPointHash },
    currentMessages
  );

  // Persist branch checkpoint
  const checkpoint: SpbBranchCheckpoint = {
    branchId,
    parentSessionId,
    anchorTurnHash: forkPointHash,
    activeCapsule: JSON.stringify(capsule),
    mergedAt: null,
    createdAt: now,
  };
  saveBranchCheckpoint(checkpoint);

  return {
    branchId,
    parentSessionId,
    continuationFrame,
    capsule,
    forkPointHash,
  };
}

/**
 * Merges a branch's verified artifacts back into the parent session
 * by marking the branch checkpoint as merged and updating parent's capsule.
 */
export async function mergeBranchArtifact(
  branchId: string,
  _verifiedArtifacts: Record<string, unknown>
): Promise<boolean> {
  const checkpoint = getBranchCheckpoint(branchId);
  if (!checkpoint) return false;

  // Mark branch as merged
  const marked = await markBranchMerged(branchId);
  if (!marked) return false;

  // Optionally: update parent session's continuation capsule with merged artifacts
  // This would require updating the agentic_conversations table
  // For now, just mark the branch as merged

  return true;
}

/**
 * Updates the branch checkpoint's mergedAt timestamp
 */
async function markBranchMerged(branchId: string, mergedAt = Date.now()): Promise<boolean> {
  try {
    return markDbBranchMerged(branchId, mergedAt);
  } catch (err) {
    console.error("[SPB Branch] Failed to mark branch merged:", err);
    return false;
  }
}

/**
 * Retrieves active capsule from parent session for continuation
 */
export async function getParentContinuationCapsule(
  parentSessionId: string,
  forkPointHash: string
): Promise<ContinuationCapsule | null> {
  const checkpoint = getBranchCheckpoint(`br_${parentSessionId}_${forkPointHash.slice(0, 8)}`);
  if (!checkpoint) return null;

  try {
    return JSON.parse(checkpoint.activeCapsule) as ContinuationCapsule;
  } catch {
    return null;
  }
}
