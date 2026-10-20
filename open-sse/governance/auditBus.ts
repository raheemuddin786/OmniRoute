/**
 * Governance audit bus — bounded, non-blocking, content-free audit trail.
 *
 * DESIGN CONTRACT (the whole point of this module):
 *
 *  1. **No content, ever.** A governance record carries a `promptHash` and
 *     numeric counters — NEVER the prompt, the response, or any tool argument.
 *     This is an audit trail, not a content store. `assertNoContent` is enforced
 *     by the record shape itself (the interface has no content field).
 *
 *  2. **Zero added latency on the hot path.** `record()` is SYNCHRONOUS and does
 *     no I/O: it appends to an in-memory ring buffer and hands the entry to the
 *     registered sinks. Sinks are expected to enqueue, not to persist — the
 *     same contract as `RoutingEventSink` in
 *     `open-sse/services/routing/events.ts`, whose `record()` is documented as
 *     "must never do sync I/O". A sink that throws is isolated: the request
 *     must never fail because observability misbehaved.
 *
 *  3. **Never await I/O inline.** The flush to an external sink is the sink's
 *     own business; the bus itself never awaits.
 *
 *  4. **Fail OPEN.** Any internal exception drops the audit record and LOGS
 *     that it did so. It never breaks the user's request. The failure counter
 *     makes the drop visible instead of silent.
 *
 *  5. **Overflow is counted, never silent.** The ring buffer is bounded; when it
 *     wraps, `overflowCount` and `droppedCount` increase. Dropping an audit
 *     entry is a real (if bounded) loss of observability, so it is surfaced via
 *     `getAuditBusStats()` rather than vanishing.
 *
 * IDENTITY: this module does NOT invent a parallel id scheme. `sessionId` and
 * `principalId` are supplied by the caller from the EXISTING identity
 * resolution:
 *  - principal = the API-key id (`apiKeyInfo.id` → `String(...)`), the same
 *    value the compression principal uses (`chatCore.ts` `compressionPrincipalId`)
 *    and the `mcp_tool_audit.api_key_id` value.
 *  - session = the existing session fingerprint (`generateSessionId()` from
 *    `open-sse/services/sessionManager.ts`, or `extractExternalSessionId()`).
 *
 * The sessionManager maps are in-memory with a 15-minute TTL and a 200-session
 * cap, so a session-keyed policy MUST tolerate eviction. Nothing here depends on
 * the session still being present — the session id is just a bucket label.
 */

import { jsonSha256 } from "../utils/jsonHash.ts";
import { logger } from "../utils/logger.ts";

const log = logger("GOVERNANCE");

/** One governance audit entry. Deliberately content-free. */
export interface GovernanceAuditRecord {
  /** Existing session identity (sessionManager fingerprint or `ext:<raw>`). */
  sessionId: string;
  /** Monotonic turn index within the session. */
  turnIndex: number;
  /** Epoch milliseconds when the record was created. */
  timestamp: number;
  /** SHA-256 of the canonical message array. Never the messages themselves. */
  promptHash: string;
  /** Tool names the model asked for. Names only — never arguments. */
  toolCallsRequested: string[];
  /** Tool names that were actually executed/observed. Names only. */
  toolCallsExecuted: string[];
  tokensIn: number;
  tokensOut: number;
  model: string;
  provider: string;
  compressionApplied: boolean;
  /**
   * API-key id when known — the CCR tenancy boundary and the
   * `mcp_tool_audit.api_key_id` value. Optional because the local (no-auth)
   * path has none.
   */
  principalId?: string;
  /**
   * Request correlation id — reuse `generateRequestId()` from
   * `open-sse/handlers/chatCore.ts` so a governance row joins to
   * `compression_analytics.request_id`.
   */
  requestId?: string;
  /** Free-form governance event kind (e.g. "tool_call.rejected"). */
  event?: string;
  /** Extra counters. Numbers and short strings only — never content. */
  details?: Record<string, number | string | boolean>;
}

/**
 * A sink consumes governance records. `record()` MUST be cheap and MUST NOT
 * perform synchronous I/O — it may enqueue for a later flush. A sink that
 * throws is isolated by the bus.
 */
export interface GovernanceAuditSink {
  readonly name: string;
  record(record: GovernanceAuditRecord): void;
}

const DEFAULT_CAPACITY = 10_000;

export interface AuditBusOptions {
  /** Ring-buffer capacity. Default 10 000. */
  capacity?: number;
  /** Initial sinks. */
  sinks?: GovernanceAuditSink[];
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface AuditBusStats {
  capacity: number;
  /** Entries currently held in the ring buffer. */
  size: number;
  /** Total records accepted since process start. */
  recorded: number;
  /** How many times the ring buffer wrapped (oldest entries evicted). */
  overflowCount: number;
  /** Total records evicted by the ring buffer. */
  droppedCount: number;
  /** Records lost because a sink or the bus itself threw. */
  failedCount: number;
  /** Currently registered sink names. */
  sinks: string[];
}

/**
 * Compute the prompt hash over the CANONICAL message array.
 *
 * Canonical = sorted-key JSON of the message array, hashed with the repo's
 * streaming SHA-256 (`jsonSha256`). Sorting the keys makes the hash stable
 * against key-order differences between otherwise identical requests, which a
 * plain `jsonSha256(messages)` would not be.
 *
 * Uses `jsonSha256` (NOT `JSON.stringify`) so a multi-megabyte body is never
 * materialized as one string — that is the #7847 OOM class `jsonHash.ts` exists
 * to prevent.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      out[key] = canonicalizeJson(item);
    }
    return out;
  }
  return value;
}

/**
 * Hash the canonical form of a message array.
 *
 * Accepts the OpenAI Chat / Anthropic Messages shape (`messages`) and the
 * OpenAI Responses shape (`input`) — BOTH exist on the same request body, so a
 * hash keyed only on `messages` would silently no-op on `/v1/responses`.
 *
 * The SHAPE is part of the hash. A Chat body and a Responses body can carry
 * byte-identical message arrays (`[{role:"user",content:"hi"}]`), and hashing
 * the array alone would give them the SAME digest — collapsing two different
 * requests onto one audit row. The shape tag is therefore mixed in, so the
 * digest identifies the request uniquely.
 */
export function hashPromptMessages(body: unknown): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (Array.isArray(record.messages)) {
    return jsonSha256(canonicalizeJson({ shape: "messages", value: record.messages }));
  }
  if (Array.isArray(record.input)) {
    return jsonSha256(canonicalizeJson({ shape: "input", value: record.input }));
  }
  return jsonSha256(canonicalizeJson({ shape: "none", value: [] }));
}

/** Bounded in-memory ring buffer of governance records. */
export class GovernanceAuditBus {
  private readonly capacity: number;
  private readonly buffer: GovernanceAuditRecord[] = [];
  private cursor = 0;
  private readonly sinks = new Set<GovernanceAuditSink>();
  private readonly now: () => number;

  private recorded = 0;
  private overflowCount = 0;
  private droppedCount = 0;
  private failedCount = 0;

  constructor(options: AuditBusOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    // A non-positive capacity would make every record an immediate overflow.
    this.capacity =
      Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : DEFAULT_CAPACITY;
    this.now = options.now ?? (() => Date.now());
    for (const sink of options.sinks ?? []) this.sinks.add(sink);
  }

  /**
   * Build the immutable record entry from the caller's input.
   *
   * Every field is defaulted, so the ring buffer always holds the same shape.
   */
  private buildEntry(
    input: Omit<GovernanceAuditRecord, "timestamp"> & { timestamp?: number }
  ): GovernanceAuditRecord {
    return {
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      timestamp: input.timestamp ?? this.now(),
      promptHash: input.promptHash,
      toolCallsRequested: [...(input.toolCallsRequested ?? [])],
      toolCallsExecuted: [...(input.toolCallsExecuted ?? [])],
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      model: input.model ?? "",
      provider: input.provider ?? "",
      compressionApplied: input.compressionApplied === true,
      ...(input.principalId !== undefined ? { principalId: input.principalId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.event !== undefined ? { event: input.event } : {}),
      ...(input.details !== undefined ? { details: { ...input.details } } : {}),
    };
  }

  /**
   * Hand the entry to every registered sink.
   *
   * A misbehaving sink must never break the data plane: its failure is
   * counted and the remaining sinks still receive the record.
   */
  private dispatchToSinks(entry: GovernanceAuditRecord): void {
    for (const sink of this.sinks) {
      try {
        sink.record(entry);
      } catch (err) {
        this.failedCount += 1;
        log.warn("audit sink threw; isolated", {
          sink: sink.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Record one governance entry.
   *
   * SYNCHRONOUS and non-blocking. Never throws: any internal failure is
   * counted, logged, and swallowed (fail OPEN) so the user's request is
   * unaffected.
   */
  record(input: Omit<GovernanceAuditRecord, "timestamp"> & { timestamp?: number }): void {
    try {
      const entry = this.buildEntry(input);

      if (this.buffer.length < this.capacity) {
        this.buffer.push(entry);
      } else {
        // Ring full — overwrite the oldest slot and COUNT the drop. Silently
        // discarding an audit entry would be a false sense of coverage.
        this.buffer[this.cursor] = entry;
        this.overflowCount += 1;
        this.droppedCount += 1;
      }
      this.cursor = (this.cursor + 1) % this.capacity;
      this.recorded += 1;

      this.dispatchToSinks(entry);
    } catch (err) {
      // Fail OPEN: drop the record, log that we dropped it, never throw.
      this.failedCount += 1;
      log.error("audit record failed; dropped (fail-open)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Register a sink. Returns an unsubscribe function. Idempotent per instance. */
  registerSink(sink: GovernanceAuditSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  /** Remove every registered sink. */
  clearSinks(): void {
    this.sinks.clear();
  }

  /** Most recent records, newest first. */
  recent(limit = 50): GovernanceAuditRecord[] {
    const out: GovernanceAuditRecord[] = [];
    const total = this.buffer.length;
    for (let i = 0; i < Math.min(limit, total); i++) {
      const idx = (this.cursor - 1 - i + total) % total;
      out.push(this.buffer[idx]);
    }
    return out;
  }

  /** All records for one session, oldest first. */
  bySession(sessionId: string): GovernanceAuditRecord[] {
    return this.buffer.filter((entry) => entry.sessionId === sessionId);
  }

  /** Drop every buffered record. Does not reset the counters. */
  clear(): void {
    this.buffer.length = 0;
    this.cursor = 0;
  }

  get stats(): AuditBusStats {
    return {
      capacity: this.capacity,
      size: this.buffer.length,
      recorded: this.recorded,
      overflowCount: this.overflowCount,
      droppedCount: this.droppedCount,
      failedCount: this.failedCount,
      sinks: Array.from(this.sinks, (sink) => sink.name),
    };
  }
}

/** Process-wide default bus. */
const globalBus = new GovernanceAuditBus();

/** Record on the process-wide bus. Never throws. */
export function recordGovernanceAudit(
  input: Omit<GovernanceAuditRecord, "timestamp"> & { timestamp?: number }
): void {
  globalBus.record(input);
}

/** Read the process-wide bus stats. */
export function getAuditBusStats(): AuditBusStats {
  return globalBus.stats;
}

/** Most recent records on the process-wide bus, newest first. */
export function getRecentGovernanceAudit(limit = 50): GovernanceAuditRecord[] {
  return globalBus.recent(limit);
}

/** The process-wide bus (exported for tests and for sink registration). */
export function getGovernanceAuditBus(): GovernanceAuditBus {
  return globalBus;
}

/**
 * A `RoutingEventSink`-shaped sink over the governance audit bus.
 *
 * The routing event bus (`open-sse/services/routing/events.ts`) is the repo's
 * established pattern for a hot-path, synchronous, non-blocking fan-out: a
 * sink exposes `name` + `record(event)` and must never do synchronous I/O.
 * The governance bus mirrors that contract exactly, so an operator can plug a
 * governance sink into the SAME infrastructure without a second bespoke
 * plumbing contract.
 */
export type GovernanceRoutingEventSink = GovernanceAuditSink;

/**
 * Register a governance sink on the process-wide bus.
 *
 * Returns the unsubscribe function, exactly like `registerRoutingEventSink`.
 */
export function registerGovernanceAuditSink(sink: GovernanceRoutingEventSink): () => void {
  return globalBus.registerSink(sink);
}

/** Remove every governance sink from the process-wide bus. */
export function clearGovernanceAuditSinks(): void {
  globalBus.clearSinks();
}
