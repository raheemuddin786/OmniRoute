/**
 * chatCore governance ingress — the request-side half of the proxy
 * governance layer.
 *
 * This is the ONE place the governance layer touches the request body. It
 * runs on the CLIENT-FORMAT body, before the request is translated to the
 * upstream wire format, so the repo's existing request translators carry the
 * governance artifacts into whatever the upstream format is (no new
 * per-format translation path is introduced).
 *
 * TWO THINGS HAPPEN HERE
 *
 *  1. **LOOP INTERVENTION** — a loop was detected on the previous turn's
 *     egress (the model called the same tool with the same arguments three
 *     times, or ping-ponged between two calls). The intervention is a
 *     synthetic SYSTEM message injected into this request's context telling
 *     the model to halt and change approach. It is consumed exactly once —
 *     the next turn of the same session picks it up and it is then dropped.
 *
 *  2. **TOOL-CALL REJECTION ENFORCEMENT** — the client echoes the assistant
 *     turn (with the model's tool calls) plus the tool results back to the
 *     proxy. For every tool call the proxy rejected on the egress, the
 *     client's tool result is REPLACED with a synthetic error result in the
 *     request format's existing error shape, so the model reads the
 *     rejection instead of the client's real output.
 *
 * SESSION IDENTITY
 *
 * The session key is resolved ONCE per request, from the CLIENT body BEFORE
 * any governance injection, and is threaded to the egress tap. Injecting the
 * intervention must not change the key the NEXT turn resolves, or the loop
 * breaker's window would reset every turn.
 *
 * FAIL OPEN
 *
 *  Every step is wrapped: a governance failure returns the body UNMODIFIED.
 *  A governance failure must never corrupt a user's request.
 */

import { logger } from "../../utils/logger.ts";
import {
  injectGovernanceIntervention,
  consumeLoopIntervention,
} from "../../governance/loopIntervention.ts";
import { enforceToolCallRejections } from "../../governance/toolRejectionEnforcer.ts";
import { getToolRejectionLedger } from "../../governance/toolRejectionLedger.ts";
import { recordGovernanceAudit, hashPromptMessages } from "../../governance/auditBus.ts";
import { resolveGovernanceIdentity, type GovernanceIdentity } from "../../governance/identity.ts";
import type { ToolCallValidationContext } from "../../governance/toolSchemaValidator.ts";

const log = logger("GOVERNANCE");

/** Upper bound on the per-session turn counter map. */
const MAX_TURN_COUNTER_SESSIONS = 500;

/**
 * Per-session turn counter.
 *
 * The audit record carries a `turnIndex` so an operator can order the rows of
 * one session. Bounded (LRU) because the session store itself is in-memory
 * with a TTL and a hard cap — a session-keyed counter must tolerate eviction.
 */
const turnCounters = new Map<string, number>();

/** The next turn index for a session. */
export function nextGovernanceTurnIndex(sessionId: string): number {
  if (!sessionId) return 0;
  const current = turnCounters.get(sessionId) ?? 0;
  const next = current + 1;
  turnCounters.set(sessionId, next);
  if (turnCounters.size > MAX_TURN_COUNTER_SESSIONS) {
    let oldestKey: string | null = null;
    let oldestValue = Infinity;
    for (const [key, value] of turnCounters) {
      if (value < oldestValue) {
        oldestValue = value;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) turnCounters.delete(oldestKey);
  }
  return next;
}

/** Reset the turn counters (tests). */
export function resetGovernanceTurnCounters(): void {
  turnCounters.clear();
}

export interface GovernanceIdentityInput {
  /** The client-format request body (used for the conversation fingerprint). */
  body?: unknown;
  /** Request headers — either a `Headers` instance or the plain record. */
  headers?: Headers | Record<string, unknown> | null | undefined;
  provider?: string | null;
  connectionId?: string | null;
  /** Fallback key when neither the header nor the body yields a fingerprint. */
  fallback?: string | null;
}

/**
 * Resolve the governance identity for a request.
 *
 * Thin wrapper over `governance/identity.ts` so the chatCore call site does
 * not need to know the identity module's shape. Never throws.
 */
export function resolveGovernanceRequestIdentity(
  input: GovernanceIdentityInput,
  apiKeyInfo?: { id?: string | number | null } | null
): GovernanceIdentity {
  try {
    return resolveGovernanceIdentity(input, apiKeyInfo);
  } catch (err) {
    log.error("governance identity resolution failed (fail-open)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { sessionId: input.fallback || "anonymous", source: "fallback" };
  }
}

export interface GovernanceIngressInput {
  /** The client-format request body (never mutated). */
  body: unknown;
  /** The governance session key (resolved ONCE per request). */
  sessionId: string;
  /** The client wire format — selects the carrier of the intervention. */
  sourceFormat?: string | null;
  /** API-key id when known. */
  principalId?: string;
  /** Request correlation id. */
  requestId?: string;
  model?: string;
  provider?: string;
  turnIndex?: number;
  /** Prompt hash for the audit rows (never the prompt itself). */
  promptHash?: string;
}

/**
 * Consume the parked loop intervention for this session and inject it.
 *
 * Returns the (possibly rewritten) body. The intervention is consumed exactly
 * once — the next turn of the same session picks it up and it is then
 * dropped.
 */
function applyLoopIntervention(input: GovernanceIngressInput, body: unknown): unknown {
  const intervention = consumeLoopIntervention(input.sessionId);
  if (!intervention) return body;

  const injected = injectGovernanceIntervention(
    body as Record<string, unknown>,
    intervention,
    input.sourceFormat
  );
  if (injected === body) return body;

  recordGovernanceAudit({
    sessionId: input.sessionId,
    turnIndex: input.turnIndex ?? 0,
    promptHash: input.promptHash ?? "",
    toolCallsRequested: [],
    toolCallsExecuted: [],
    tokensIn: 0,
    tokensOut: 0,
    model: input.model ?? "",
    provider: input.provider ?? "",
    compressionApplied: false,
    ...(input.principalId !== undefined ? { principalId: input.principalId } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    event: "loop.intervention_injected",
    details: { sourceFormat: input.sourceFormat ?? "" },
  });
  return injected;
}

/**
 * Replace the results of the rejected tool calls with synthetic errors.
 *
 * Returns the (possibly rewritten) body.
 */
function applyRejectionEnforcement(input: GovernanceIngressInput, body: unknown): unknown {
  const validationContext: ToolCallValidationContext = {
    body,
    sessionId: input.sessionId,
    ...(input.principalId !== undefined ? { principalId: input.principalId } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.sourceFormat ? { clientFormat: input.sourceFormat } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.turnIndex !== undefined ? { turnIndex: input.turnIndex } : {}),
    ...(input.promptHash !== undefined ? { promptHash: input.promptHash } : {}),
  };

  const ledger = getToolRejectionLedger();
  const { body: enforcedBody, rejections } = enforceToolCallRejections(
    body,
    validationContext,
    ledger
  );
  if (rejections.length === 0) return body;

  log.info("tool call rejections enforced on the request", {
    count: rejections.length,
    sessionId: input.sessionId,
  });
  return enforcedBody;
}

/**
 * Apply the governance ingress to a request body.
 *
 * Returns the (possibly rewritten) body. The input body is never mutated —
 * every rewrite produces a new object.
 */
export function applyGovernanceIngress<T>(input: GovernanceIngressInput): T {
  let body = input.body;

  // ── 1. Loop intervention ──
  try {
    body = applyLoopIntervention(input, body);
  } catch (err) {
    log.error("loop intervention injection failed (fail-open)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 2. Tool-call rejection enforcement ──
  try {
    body = applyRejectionEnforcement(input, body);
  } catch (err) {
    log.error("tool-call rejection enforcement failed (fail-open)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return body as T;
}

export { hashPromptMessages };
