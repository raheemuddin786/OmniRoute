/**
 * Tool-rejection enforcement — the INGRESS half of the tool-schema validator.
 *
 * WHY THE ENFORCEMENT LIVES HERE
 *
 * The tool-schema validator (`toolSchemaValidator.ts`) can only decide that a
 * tool call VIOLATES the request's own tool catalog. Delivering the rejection
 * to the model requires a REQUEST-side artifact: a tool RESULT. A response
 * stream carries tool CALLS (the model asking), never tool RESULTS (the
 * client answering), so a rejection cannot be delivered by editing the
 * response stream — the client would execute the rejected call and the model
 * would receive whatever the client produced.
 *
 * The proxy's only lever is the NEXT turn: the client sends the assistant
 * message (with the model's tool calls) plus the tool results back to the
 * proxy. The proxy replaces the client's tool result with a synthetic error
 * result in the format's EXISTING error shape, so the model reads the
 * rejection instead of the client's real output.
 *
 * THE LEDGER IS THE SOURCE OF TRUTH
 *
 * A rejected call is normally seen twice: on the egress of turn N (when the
 * model streamed it) and on the ingress of turn N+1 (when the client echoed
 * it back). The shared ledger (`toolRejectionLedger.ts`) holds the rejection,
 * so the ingress does NOT re-validate against the turn N+1 catalog — which
 * may legitimately differ from turn N's — and the audit row is written exactly
 * once per call.
 *
 * A call the ledger does not know about (a format the egress tap does not
 * cover, or a call the client invented) is validated against the current
 * request's catalog as a fallback.
 *
 * EXISTING SHAPES — REUSED, NOT INVENTED
 *
 *  - OpenAI Chat request: the `role:"tool"` message's `content` becomes
 *    `[tool_error: true]\n<message>`. The OpenAI tool role has NO `is_error`
 *    field (strict upstreams reject unknown message fields), and the repo's
 *    own Claude→OpenAI request translator already uses exactly this marker
 *    (`open-sse/translator/request/claude-to-openai.ts`: "The OpenAI tool role
 *    has no is_error field (strict upstreams reject unknown message fields):
 *    keep the failure visible with a marker."). Reusing the marker keeps the
 *    two paths byte-consistent.
 *  - Anthropic request: the `tool_result` block becomes
 *    `{type:"tool_result", tool_use_id, content, is_error:true}` — the shape
 *    `open-sse/translator/request/openai-to-claude.ts` builds for every
 *    Anthropic tool result.
 *  - Responses request: the `function_call_output` item's `output` becomes
 *    `JSON.stringify({error: message})` — the shape
 *    `src/lib/skills/interception.ts` builds for a Responses tool result.
 *
 * FAIL OPEN
 *
 * A body shape the extractor does not recognise, an internal exception, or a
 * catalog that is unavailable → the body is returned UNMODIFIED. A governance
 * failure must never corrupt a user's request.
 */

import { logger } from "../utils/logger.ts";
import {
  validateToolCall,
  auditToolCallRejection,
  type ToolCallDescriptor,
  type ToolCallValidationContext,
  type ToolCallRejectionReason,
} from "./toolSchemaValidator.ts";
import {
  buildRejectionKey,
  getToolRejectionLedger,
  type ToolRejectionLedger,
} from "./toolRejectionLedger.ts";

const log = logger("GOVERNANCE");

/** The marker the repo's Claude→OpenAI request translator already uses. */
export const OPENAI_TOOL_ERROR_MARKER = "[tool_error: true]";

export interface EgressToolCall {
  callId: string;
  name: string;
  /** Raw arguments — a JSON string for OpenAI, an object for Anthropic. */
  arguments: unknown;
  /** True when the call is from a historical turn, not the active turn being answered. */
  isHistorical?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentBlocksOf(message: Record<string, unknown>): unknown[] | null {
  return Array.isArray(message.content) ? (message.content as unknown[]) : null;
}

/** The tool calls carried by one OpenAI-style assistant message. */
function openAIAssistantCalls(msg: Record<string, unknown>, out: EgressToolCall[]): void {
  if (!Array.isArray(msg.tool_calls)) return;
  for (const rawCall of msg.tool_calls as unknown[]) {
    const call = asRecord(rawCall);
    if (!call) continue;
    const fn = asRecord(call.function);
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) continue;
    out.push({
      callId: typeof call.id === "string" ? call.id : "",
      name,
      arguments: fn?.arguments,
    });
  }
}

/** The tool calls carried by one Anthropic-style assistant message. */
function anthropicAssistantCalls(msg: Record<string, unknown>, out: EgressToolCall[]): void {
  const blocks = contentBlocksOf(msg);
  if (!blocks) return;
  for (const rawBlock of blocks) {
    const block = asRecord(rawBlock);
    if (!block || block.type !== "tool_use") continue;
    const name = typeof block.name === "string" ? block.name : "";
    if (!name) continue;
    out.push({
      callId: typeof block.id === "string" ? block.id : "",
      name,
      arguments: block.input,
    });
  }
}

/** The tool calls carried by one Responses-style `input[]` item. */
function responsesInputCalls(item: Record<string, unknown>, out: EgressToolCall[]): void {
  if (item.type !== "function_call") return;
  const name = typeof item.name === "string" ? item.name : "";
  if (!name) return;
  out.push({
    callId: typeof item.call_id === "string" ? item.call_id : "",
    name,
    arguments: item.arguments,
  });
}

/**
 * Extract the tool calls the model made in a PREVIOUS turn, as echoed in this
 * request, together with the tool results that answered them.
 *
 * The three source shapes are the ones the repo's request translators
 * already consume:
 *  - OpenAI Chat: assistant `tool_calls[]` + `role:"tool"` messages
 *  - Anthropic: assistant `tool_use` blocks + user `tool_result` blocks
 *  - Responses: `input[]` `function_call` items + `function_call_output` items
 */
export function extractEchoedToolCalls(body: unknown): EgressToolCall[] {
  const out: EgressToolCall[] = [];
  const record = asRecord(body);
  if (!record) return out;

  // ── OpenAI Chat + Anthropic: assistant messages ──
  if (Array.isArray(record.messages)) {
    const rawMessages = record.messages as unknown[];
    // Find index of the latest assistant message containing tool calls
    let lastAssistantIdx = -1;
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const msg = asRecord(rawMessages[i]);
      if (!msg) continue;
      const isAssistant =
        msg.role === "assistant" ||
        (Array.isArray(msg.content) &&
          (msg.content as unknown[]).some((b) => asRecord(b)?.type === "tool_use"));
      if (
        isAssistant &&
        (Array.isArray(msg.tool_calls) ||
          (Array.isArray(msg.content) &&
            (msg.content as unknown[]).some((b) => asRecord(b)?.type === "tool_use")))
      ) {
        lastAssistantIdx = i;
        break;
      }
    }

    for (let i = 0; i < rawMessages.length; i++) {
      const msg = asRecord(rawMessages[i]);
      if (!msg) continue;
      const isHistorical = lastAssistantIdx !== -1 && i < lastAssistantIdx;
      const tempCalls: EgressToolCall[] = [];
      openAIAssistantCalls(msg, tempCalls);
      anthropicAssistantCalls(msg, tempCalls);
      if (isHistorical) {
        for (const c of tempCalls) {
          c.isHistorical = true;
        }
      }
      out.push(...tempCalls);
    }
  }

  // ── Responses: input[] function_call items ──
  if (Array.isArray(record.input)) {
    for (const rawItem of record.input as unknown[]) {
      const item = asRecord(rawItem);
      if (!item) continue;
      responsesInputCalls(item, out);
    }
  }

  return out;
}

/**
 * Replace the tool results that answered the rejected calls with a synthetic
 * error result, in the request format's EXISTING error shape.
 *
 * Returns the (possibly rewritten) body. The input is never mutated.
 *
 * The OpenAI `role:"tool"` messages and the Anthropic `tool_result` blocks
 * BOTH live in `messages[]`, so the two rewrites run over the same array in
 * one pass — a per-format early return would drop the other one.
 */
export function applyToolCallRejections<T>(
  body: T,
  rejections: Map<string, { message: string; reason: ToolCallRejectionReason }>
): T {
  if (rejections.size === 0) return body;
  const record = asRecord(body);
  if (!record) return body;

  try {
    // ── OpenAI Chat + Anthropic: messages[] ──
    if (Array.isArray(record.messages)) {
      let changed = false;
      const messages = (record.messages as unknown[]).map((rawMessage) => {
        const msg = asRecord(rawMessage);
        if (!msg) return rawMessage;

        // OpenAI Chat: the `role:"tool"` message.
        if (msg.role === "tool") {
          const callId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
          const rejection = rejections.get(callId);
          if (!rejection) return rawMessage;
          const currentContent = typeof msg.content === "string" ? msg.content : "";
          if (currentContent.startsWith(OPENAI_TOOL_ERROR_MARKER)) {
            return rawMessage;
          }
          changed = true;
          // The OpenAI tool role has no `is_error` field — the repo's own
          // Claude→OpenAI translator uses this marker for the same reason.
          const marker = `${OPENAI_TOOL_ERROR_MARKER}\n${rejection.message}`;
          return { ...msg, content: marker };
        }

        // Anthropic: a `tool_result` block inside a user message.
        const blocks = contentBlocksOf(msg);
        if (!blocks) return rawMessage;
        let blockChanged = false;
        const nextBlocks = blocks.map((rawBlock) => {
          const block = asRecord(rawBlock);
          if (!block || block.type !== "tool_result") return rawBlock;
          if (block.is_error === true) return rawBlock;
          const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          const rejection = rejections.get(callId);
          if (!rejection) return rawBlock;
          blockChanged = true;
          return {
            ...block,
            content: rejection.message,
            is_error: true,
          };
        });
        if (!blockChanged) return rawMessage;
        changed = true;
        return { ...msg, content: nextBlocks };
      });

      if (!changed) return body;
      return { ...record, messages } as unknown as T;
    }

    // ── Responses: input[] function_call_output items ──
    if (Array.isArray(record.input)) {
      let changed = false;
      const input = (record.input as unknown[]).map((rawItem) => {
        const item = asRecord(rawItem);
        if (!item || item.type !== "function_call_output") return rawItem;
        const callId = typeof item.call_id === "string" ? item.call_id : "";
        const rejection = rejections.get(callId);
        if (!rejection) return rawItem;
        changed = true;
        return {
          ...item,
          output: JSON.stringify({ error: rejection.message }),
        };
      });
      if (!changed) return body;
      return { ...record, input } as unknown as T;
    }

    return body;
  } catch (err) {
    log.error("failed to apply tool-call rejections (fail-open)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return body;
  }
}

/** One rejection, as reported back to the caller. */
export interface EnforcedRejection {
  callId: string;
  name: string;
  reason: ToolCallRejectionReason;
  message: string;
}

/**
 * Decide whether ONE echoed call must be rejected.
 *
 * LEDGER-FIRST: a call the ledger already knows as rejected is enforced from
 * the ledger entry — no re-validation against the CURRENT request's catalog
 * (which may legitimately differ from the turn that produced the call), and
 * no second audit row. A call the ledger does not know is validated against
 * the current catalog as a fallback; the ledger then records it, and the
 * audit row is written only when this is the FIRST sighting of that call id.
 *
 * Returns `null` when the call is not rejected.
 */
function resolveRejection(
  call: EgressToolCall,
  context: ToolCallValidationContext,
  ledger: ToolRejectionLedger
): EnforcedRejection | null {
  // The ledger key is SCOPED to the conversation: a provider call id is unique
  // only within one conversation, so an unscoped key would let one
  // conversation's rejection rewrite an unrelated conversation's tool result.
  const key = buildRejectionKey(context.sessionId, call.callId);

  const known = ledger.get(key);
  if (known) {
    return {
      callId: call.callId,
      name: call.name || known.name,
      reason: known.reason as ToolCallRejectionReason,
      message: known.message,
    };
  }

  // Skip validation and rejection enforcement for historical tool calls
  // Historical calls are from previous turns and their results have already been processed
  if (call.isHistorical) {
    return null;
  }

  const descriptor: ToolCallDescriptor = {
    name: call.name,
    arguments: call.arguments,
    callId: call.callId,
  };
  const outcome = validateToolCall(descriptor, context);
  if (outcome.ok !== false) return null;

  ledger.record(key, call.name, outcome.reason, outcome.message);
  if (ledger.markAudited(key)) {
    auditToolCallRejection(descriptor, outcome.reason, context);
  }
  return {
    callId: call.callId,
    name: call.name,
    reason: outcome.reason,
    message: outcome.message,
  };
}

/**
 * Validate the tool calls echoed in a request and rewrite the results of the
 * rejected ones.
 *
 * Returns the (possibly rewritten) body plus the list of rejections, so the
 * caller can audit them. Never throws.
 */
export function enforceToolCallRejections<T>(
  body: T,
  context: ToolCallValidationContext,
  ledger?: ToolRejectionLedger
): {
  body: T;
  rejections: EnforcedRejection[];
} {
  const empty: { body: T; rejections: EnforcedRejection[] } = { body, rejections: [] };
  try {
    const calls = extractEchoedToolCalls(body);
    if (calls.length === 0) return empty;

    const activeLedger = ledger ?? getToolRejectionLedger();
    // The rewrite map is keyed by the WIRE call id (that is what the request's
    // `tool_call_id` / `tool_use_id` / `call_id` carries), while the LEDGER is
    // keyed by the session-scoped key. The two are kept apart deliberately.
    const rejections = new Map<string, { message: string; reason: ToolCallRejectionReason }>();
    const details: EnforcedRejection[] = [];

    for (const call of calls) {
      if (!call.callId) continue;
      const rejection = resolveRejection(call, context, activeLedger);
      if (!rejection) continue;
      rejections.set(call.callId, { message: rejection.message, reason: rejection.reason });
      details.push(rejection);
    }

    if (rejections.size === 0) return { body, rejections: details };

    for (const callId of rejections.keys()) {
      activeLedger.markEnforced(buildRejectionKey(context.sessionId, callId));
    }

    return {
      body: applyToolCallRejections(body, rejections),
      rejections: details,
    };
  } catch (err) {
    log.error("tool-call rejection enforcement failed (fail-open)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}
