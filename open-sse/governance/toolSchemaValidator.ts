/**
 * Tool-schema validator — validates a COMPLETE tool call against the
 * session's registered tool catalog.
 *
 * WHAT IS VALIDATED
 *
 *  1. The tool NAME exists in the catalog (the request's `tools[]`).
 *  2. The tool ARGUMENTS validate against the tool's JSON Schema, when the
 *     catalog carries one.
 *
 * CATALOG SOURCE — REUSED, NOT DUPLICATED
 *
 *  The catalog comes from `extractToolSchemaMap(body)`
 *  (`open-sse/translator/response/openai-responses/toolSchemas.ts`), which
 *  already normalizes BOTH request shapes:
 *    - Chat Completions: `{type:"function", function:{name, parameters}}`
 *    - Responses API:   `{type:"function", name, parameters}` (and `input_schema`)
 *  It returns `null` when there is no usable `tools[]` — that is exactly the
 *  "catalog unavailable" case below. The tool-NAME catalog comes from
 *  `collectDeclaredToolNames(body)`
 *  (`open-sse/translator/response/openai-responses/declaredToolName.ts`), which
 *  accepts the same shapes plus Responses `type:"namespace"` children.
 *
 * CATALOG UNAVAILABLE → SKIP (never reject)
 *
 *  When the catalog is unavailable (no `tools[]` on the request, MCP not
 *  connected, …) validation is SKIPPED and a DEGRADED event is logged
 *  **ONCE PER SESSION**, not per request. A per-request log would flood the
 *  log on every turn of every tool-less session. The dedup set is bounded and
 *  evicts its own least-recently-used entries (the underlying sessionManager
 *  maps are in-memory with a 15-minute TTL and a 200-session cap, so a
 *  session-keyed policy MUST tolerate eviction).
 *
 * JSON-SCHEMA SUBSET — DOCUMENTED DELIBERATELY
 *
 *  The repo already depends on `ajv` (`^8.20.0`, a production dependency) and
 *  already uses it for exactly this purpose in
 *  `open-sse/translator/deepseekWebToolBinding.ts` (tool-argument schema
 *  validation). This module REUSES ajv rather than hand-rolling a JSON-Schema
 *  subset or adding a dependency: no new npm dependency is introduced, and the
 *  supported subset is ajv's (draft 2020-12), not a partial reimplementation.
 *  Compiled validators are cached per schema object so a repeated call does
 *  not re-compile.
 *
 *  Practical caveat: ajv is configured with `strict: false` and
 *  `validateFormats: false`, matching the existing repo usage. A schema that
 *  ajv cannot compile (invalid schema) is treated as "no usable schema" → the
 *  arguments are NOT validated (fail OPEN on the schema, not on the call).
 *
 * REJECTION SHAPE
 *
 *  A rejected call produces a synthetic tool result in the PROVIDER'S EXISTING
 *  error shape. There is no single "provider error shape" helper in the repo
 *  for tool results — the repo's per-format builders live on the REQUEST side
 *  (`open-sse/translator/request/openai-to-claude.ts` builds `tool_result`
 *  blocks with `is_error`; `src/lib/skills/interception.ts` builds
 *  `function_call_output` items for Responses). This module reuses those
 *  SHAPES (not a new per-provider format):
 *
 *    - OpenAI Chat: `{role:"tool", tool_call_id, content, is_error:true}`
 *    - Anthropic:   `{type:"tool_result", tool_use_id, content, is_error:true}`
 *    - Responses:   `{type:"function_call_output", call_id, output}`
 *
 *  The error TEXT is produced through `sanitizeErrorMessage()`
 *  (`open-sse/utils/error.ts`) so a raw `err.message` / `err.stack` can never
 *  reach the client (Hard Rule #12).
 *
 * FAIL OPEN
 *
 *  Any internal exception forwards the call UNMODIFIED and logs. A governance
 *  failure must never break the user's request.
 */

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import { extractToolSchemaMap } from "../translator/response/openai-responses/toolSchemas.ts";
import { collectDeclaredToolNames } from "../translator/response/openai-responses/declaredToolName.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import { FORMATS } from "../translator/formats.ts";
import { logger } from "../utils/logger.ts";
import { recordGovernanceAudit } from "./auditBus.ts";

const log = logger("GOVERNANCE");

/** Upper bound on the once-per-session DEGRADED dedup set. */
export const MAX_DEGRADED_SESSIONS = 500;

export type ToolCallRejectionReason = "unknown_tool" | "invalid_arguments" | "malformed_arguments";

export interface ToolCallDescriptor {
  /** Tool name as emitted by the model. */
  name: string;
  /** Raw arguments (already parsed to an object, or a JSON string). */
  arguments: unknown;
  /** Provider-assigned call id, when the format has one. */
  callId?: string | null;
}

export interface ToolCallValidationContext {
  /** The request body — the catalog source. */
  body: unknown;
  /** Existing session identity (sessionManager fingerprint / `ext:<raw>`). */
  sessionId: string;
  /** API-key id when known (the CCR tenancy boundary). */
  principalId?: string;
  /** Request correlation id — joins to `compression_analytics.request_id`. */
  requestId?: string;
  /** Client wire format — selects the synthetic result shape. */
  clientFormat?: string;
  /** Model / provider for the audit record. */
  model?: string;
  provider?: string;
  /** Turn index within the session. */
  turnIndex?: number;
  /** Prompt hash for the audit record (never the prompt itself). */
  promptHash?: string;
}

export type ToolCallValidationOutcome =
  | { ok: true; degraded: boolean }
  | {
      ok: false;
      reason: ToolCallRejectionReason;
      /** Sanitized, client-safe error text. */
      message: string;
      /** The synthetic tool result, in the provider's existing error shape. */
      syntheticResult: Record<string, unknown>;
    };

const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });
const validatorCache = new WeakMap<object, Map<string, ValidateFunction | null>>();

/**
 * Once-per-session DEGRADED dedup. Bounded LRU so it cannot grow without
 * limit (the session store itself is in-memory with a TTL and a hard cap).
 */
const degradedSessions = new Map<string, number>();

/** Mark a session as "degraded already reported". Returns true the first time. */
function markDegradedOnce(sessionId: string, now: number): boolean {
  if (!sessionId) return true;
  if (degradedSessions.has(sessionId)) {
    degradedSessions.set(sessionId, now);
    return false;
  }
  if (degradedSessions.size >= MAX_DEGRADED_SESSIONS) {
    // Evict the least-recently-used entry.
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, seenAt] of degradedSessions) {
      if (seenAt < oldestTime) {
        oldestTime = seenAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) degradedSessions.delete(oldestKey);
  }
  degradedSessions.set(sessionId, now);
  return true;
}

/** Reset the dedup state (tests). */
export function resetDegradedSessionLog(): void {
  degradedSessions.clear();
}

/** Number of sessions currently marked degraded (tests / ops). */
export function degradedSessionCount(): number {
  return degradedSessions.size;
}

/**
 * Parse the tool arguments.
 *
 * Model output arrives either as an already-parsed object or as a JSON string.
 * A malformed JSON string is a REJECTION (the model emitted broken arguments),
 * not an internal error.
 */
function parseArguments(
  raw: unknown
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: true, value: raw };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, message: "Tool arguments are not valid JSON." };
  }
}

/**
 * Get a cached validator for a schema object.
 *
 * The cache is keyed by the schema OBJECT's identity (a WeakMap), so a repeated
 * call with the same request body's schema does not re-compile it. A schema ajv
 * cannot compile is cached as `null` — "no usable schema" → the arguments are
 * not validated (fail OPEN on the schema, not on the call).
 */
function validatorFor(schema: object): ValidateFunction | null {
  let byName = validatorCache.get(schema);
  if (!byName) {
    byName = new Map();
    validatorCache.set(schema, byName);
  }
  const existing = byName.get("*");
  if (existing !== undefined) return existing;

  let compiled: ValidateFunction | null = null;
  try {
    compiled = ajv.compile(schema as object);
  } catch {
    compiled = null;
  }
  byName.set("*", compiled);
  return compiled;
}

/**
 * Build the synthetic tool result in the provider's existing error shape.
 */
export function buildRejectionResult(
  format: string | undefined,
  call: ToolCallDescriptor,
  message: string
): Record<string, unknown> {
  const callId = call.callId ?? "";
  if (format === FORMATS.CLAUDE) {
    return {
      type: "tool_result",
      tool_use_id: callId,
      content: message,
      is_error: true,
    };
  }
  if (format === FORMATS.OPENAI_RESPONSES) {
    return {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify({ error: message }),
    };
  }
  // OpenAI Chat Completions (default).
  return {
    role: "tool",
    tool_call_id: callId,
    content: message,
    is_error: true,
  };
}

/**
 * Validate one tool call against the session's tool catalog.
 *
 * Never throws — every internal failure fails OPEN (the call is forwarded
 * unmodified) and is logged.
 */
export function validateToolCall(
  call: ToolCallDescriptor,
  context: ToolCallValidationContext
): ToolCallValidationOutcome {
  try {
    return validateToolCallInternal(call, context);
  } catch (err) {
    // Fail OPEN: forward the call unmodified, and say so.
    log.error("tool validation failed; forwarding call unmodified (fail-open)", {
      tool: call?.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: true, degraded: false };
  }
}

/** Build a rejection outcome in the provider's existing error shape. */
function rejection(
  context: ToolCallValidationContext,
  call: ToolCallDescriptor,
  reason: ToolCallRejectionReason,
  rawMessage: string
): ToolCallValidationOutcome {
  return {
    ok: false,
    reason,
    message: sanitizeErrorMessage(rawMessage),
    syntheticResult: buildRejectionResult(context.clientFormat, call, rawMessage),
  };
}

/**
 * The session's tool catalog, or `null` when it is unavailable.
 *
 * Unavailable means "the request declared no tools" — NOT "the model called a
 * tool that was not declared". The two cases must not be confused: the first
 * skips validation (degraded), the second rejects the call.
 */
function resolveCatalog(
  body: unknown
): { declaredNames: Set<string> | null; schemaMap: Map<string, object> | null } | null {
  const declaredNames = collectDeclaredToolNames(body);
  const schemaMap = extractToolSchemaMap(body);
  if (declaredNames === null && schemaMap === null) return null;
  return { declaredNames, schemaMap };
}

/** Emit the DEGRADED event ONCE per session. */
function reportDegraded(context: ToolCallValidationContext, toolName: string): void {
  if (!markDegradedOnce(context.sessionId, Date.now())) return;
  log.warn("tool catalog unavailable; validation skipped (degraded)", {
    sessionId: context.sessionId,
    requestId: context.requestId,
  });
  recordGovernanceAudit({
    sessionId: context.sessionId,
    turnIndex: context.turnIndex ?? 0,
    promptHash: context.promptHash ?? "",
    toolCallsRequested: [toolName],
    toolCallsExecuted: [],
    tokensIn: 0,
    tokensOut: 0,
    model: context.model ?? "",
    provider: context.provider ?? "",
    compressionApplied: false,
    ...(context.principalId !== undefined ? { principalId: context.principalId } : {}),
    ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
    event: "tool_validation.degraded",
    details: { reason: "catalog_unavailable" },
  });
}

/**
 * Validate the arguments against the tool's JSON Schema.
 *
 * Returns `null` when the arguments are acceptable (or when validation was
 * skipped because the schema is unusable — fail OPEN on the schema, not on the
 * call), and a rejection outcome otherwise.
 */
function validateAgainstSchema(
  toolName: string,
  schema: object | undefined,
  rawArguments: unknown,
  context: ToolCallValidationContext,
  call: ToolCallDescriptor
): ToolCallValidationOutcome | null {
  if (!schema) return null;

  const parsed = parseArguments(rawArguments);
  if (parsed.ok === false) {
    return rejection(
      context,
      call,
      "malformed_arguments",
      `Tool "${toolName}" was called with malformed arguments: ${parsed.message}`
    );
  }

  const validate = validatorFor(schema);
  if (!validate) return null;

  let valid = false;
  try {
    valid = validate(parsed.value) === true;
  } catch (err) {
    // A throwing validator is an internal failure — fail OPEN.
    log.error("tool schema validator threw; skipping validation (fail-open)", {
      tool: toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (valid) return null;

  const detail = validate.errors
    ?.map((issue) => `${issue.instancePath || "/"} ${issue.message ?? "is invalid"}`)
    .join("; ");
  return rejection(
    context,
    call,
    "invalid_arguments",
    `Tool "${toolName}" was called with arguments that do not match its schema` +
      (detail ? `: ${detail}` : ".")
  );
}

function validateToolCallInternal(
  call: ToolCallDescriptor,
  context: ToolCallValidationContext
): ToolCallValidationOutcome {
  const toolName = typeof call?.name === "string" ? call.name.trim() : "";
  if (!toolName) {
    return rejection(context, call, "unknown_tool", "Tool call is missing a tool name.");
  }

  const catalog = resolveCatalog(context.body);
  if (!catalog) {
    // DEGRADED — log ONCE per session, not per request.
    reportDegraded(context, toolName);
    return { ok: true, degraded: true };
  }

  // ── Name check ──
  const { declaredNames, schemaMap } = catalog;
  if (declaredNames && !declaredNames.has(toolName)) {
    return rejection(
      context,
      call,
      "unknown_tool",
      `Tool "${toolName}" is not declared in this request's tool catalog.`
    );
  }

  // ── Argument schema check ──
  const schemaOutcome = validateAgainstSchema(
    toolName,
    schemaMap?.get(toolName),
    call.arguments,
    context,
    call
  );
  if (schemaOutcome) return schemaOutcome;

  return { ok: true, degraded: false };
}

/**
 * Audit a rejection through the audit bus. Called by the caller after a
 * `validateToolCall` rejection so the audit row carries the request's counters.
 */
export function auditToolCallRejection(
  call: ToolCallDescriptor,
  reason: ToolCallRejectionReason,
  context: ToolCallValidationContext
): void {
  try {
    recordGovernanceAudit({
      sessionId: context.sessionId,
      turnIndex: context.turnIndex ?? 0,
      promptHash: context.promptHash ?? "",
      toolCallsRequested: [call?.name ?? ""],
      toolCallsExecuted: [],
      tokensIn: 0,
      tokensOut: 0,
      model: context.model ?? "",
      provider: context.provider ?? "",
      compressionApplied: false,
      ...(context.principalId !== undefined ? { principalId: context.principalId } : {}),
      ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
      event: "tool_call.rejected",
      details: { reason, tool: call?.name ?? "" },
    });
  } catch (err) {
    log.error("audit of tool rejection failed (fail-open)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
