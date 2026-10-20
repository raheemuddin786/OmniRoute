/**
 * Tool-rejection ledger — the shared state between the egress detection and
 * the ingress enforcement of a rejected tool call.
 *
 * WHY A LEDGER
 *
 * A tool call is seen TWICE in a tool-using conversation:
 *
 *  1. On the EGRESS, when the model streams the call (the governance tap
 *     detects that the call violates the request's own tool catalog).
 *  2. On the INGRESS of the NEXT turn, when the client echoes the assistant
 *     turn plus the tool result back to the proxy (the governance layer
 *     rewrites the tool result so the model reads the rejection instead of
 *     the client's real output).
 *
 * Without shared state, the same call would be audited once per turn — the
 * assistant turn stays in the client's history, so every subsequent turn
 * re-presents it. The ledger makes the audit happen ONCE per call, and it
 * tells the ingress which calls to enforce.
 *
 * The ledger is bounded (LRU eviction) so a long-lived process cannot grow
 * without limit. A forgotten call id simply falls back to "validate it
 * again", which may produce a second audit row for a very old call — the
 * cost of that is one extra audit row, not a correctness problem.
 *
 * WHY THE KEY IS SCOPED (not the bare call id)
 *
 * A provider call id is unique only WITHIN ONE CONVERSATION. Two different
 * conversations served by the same proxy can both mint a call id called
 * `call_1` — and providers, SDKs and test harnesses routinely reuse short,
 * predictable ids like `call_1`, `call_0` and `call_validation`.
 *
 * Keying the ledger by the bare call id therefore lets one conversation's
 * rejection leak into an UNRELATED conversation. When that happens the
 * ingress rewrites a tool result the client legitimately produced, replacing
 * real output with a synthetic error — the model's context is silently
 * corrupted by a rejection that belonged to a different conversation.
 *
 * That is not a theoretical concern: it is exactly what
 * `tests/unit/model-validation-service.test.ts` hit. The model-validation
 * proof harness reuses the call id `call_validation` for every proof it runs.
 * A proof whose nonce is deliberately wrong has its turn-2 tool call rejected
 * on the egress and recorded under that id; the NEXT proof — a different
 * conversation with a VALID nonce — then found its legitimate tool result
 * rewritten and failed with `MODEL_VALIDATION_PROOF_FAILED`.
 *
 * THE FIX: SCOPE THE KEY BY CONVERSATION
 *
 * The ledger key is now `sessionId` + `callId`. The session id is the EXISTING
 * session identity (`sessionManager` fingerprint or `ext:<raw>` external id)
 * — the same key the rest of the governance layer uses — so a rejection can
 * only be enforced inside the conversation that produced it.
 *
 * A caller with no session id (the process-wide helper, or a request whose
 * identity could not be resolved) falls back to the bare call id, which
 * preserves the previous behaviour for callers that genuinely have no
 * conversation context. The scoped key is preferred wherever a session id is
 * available.
 */

import { logger } from "../utils/logger.ts";

const log = logger("GOVERNANCE");

/** Upper bound on remembered call ids. */
export const MAX_LEDGER_ENTRIES = 2_000;

export interface RejectionEntry {
  callId: string;
  name: string;
  reason: string;
  /** Sanitized, client-safe error text. */
  message: string;
  audited: boolean;
  enforced: boolean;
  at: number;
}

/**
 * The separator between the session scope and the call id in a ledger key.
 *
 * A space cannot appear in a provider call id or in the session ids this
 * project produces (`ext:<raw>` and the 16-hex fingerprint), so the joined
 * key is unambiguous.
 */
const SCOPE_SEPARATOR = " ";

/**
 * Build the ledger key for a call.
 *
 * With a session id the key is scoped to that conversation, so a call id
 * reused by another conversation can never resolve to this entry. Without a
 * session id the bare call id is used — the caller has no conversation
 * context to scope by, and matching the historical behaviour is the safest
 * fallback.
 */
export function buildRejectionKey(sessionId: string | null | undefined, callId: string): string {
  if (!sessionId) return callId;
  return `${sessionId}${SCOPE_SEPARATOR}${callId}`;
}

/**
 * Bounded, LRU-evicting map of rejected tool-call ids.
 */
export class ToolRejectionLedger {
  private readonly entries = new Map<string, RejectionEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { maxEntries?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? MAX_LEDGER_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  private evictIfNeeded(): void {
    if (this.entries.size < this.maxEntries) return;
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.at < oldestTime) {
        oldestTime = entry.at;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.entries.delete(oldestKey);
  }

  /**
   * Record a rejection.
   *
   * Returns true when this is the FIRST time the call id was seen (so the
   * caller knows whether the audit still has to be written).
   */
  record(callId: string, name: string, reason: string, message: string): boolean {
    if (!callId) return false;
    try {
      const existing = this.entries.get(callId);
      if (existing) {
        existing.at = this.now();
        return false;
      }
      this.evictIfNeeded();
      this.entries.set(callId, {
        callId,
        name,
        reason,
        message,
        audited: false,
        enforced: false,
        at: this.now(),
      });
      return true;
    } catch (err) {
      log.error("failed to record tool rejection (fail-open)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Read an entry. */
  get(callId: string): RejectionEntry | null {
    try {
      return this.entries.get(callId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Mark the entry as audited. Returns true when this call performed the
   * transition (so the caller writes exactly one audit row per call).
   */
  markAudited(callId: string): boolean {
    try {
      const entry = this.entries.get(callId);
      if (!entry || entry.audited) return false;
      entry.audited = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Mark the entry as enforced. Returns true on the first transition. */
  markEnforced(callId: string): boolean {
    try {
      const entry = this.entries.get(callId);
      if (!entry || entry.enforced) return false;
      entry.enforced = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the call id is already known as rejected. */
  has(callId: string): boolean {
    return this.entries.has(callId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Process-wide ledger. */
const globalLedger = new ToolRejectionLedger();

/** The process-wide ledger. */
export function getToolRejectionLedger(): ToolRejectionLedger {
  return globalLedger;
}

/**
 * Record a rejection on the process-wide ledger.
 *
 * `sessionId` scopes the entry to one conversation. Omit it only when the
 * caller genuinely has no conversation context.
 */
export function recordToolRejection(
  callId: string,
  name: string,
  reason: string,
  message: string,
  sessionId?: string | null
): boolean {
  return globalLedger.record(buildRejectionKey(sessionId, callId), name, reason, message);
}
