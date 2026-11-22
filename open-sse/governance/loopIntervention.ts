/**
 * Loop intervention — the ENFORCING half of the loop breaker.
 *
 * The loop breaker (`loopBreaker.ts`) DETECTS a repeated / ping-pong tool
 * call. This module carries the DETECTED loop across the request boundary to
 * the NEXT turn of the same session, where a synthetic system message is
 * injected into the model's context telling it to halt and change approach.
 *
 * WHY A STORE AND NOT AN INLINE INJECTION
 *
 * The detection happens on the EGRESS (the model's response carried a the
 * same tool call three times). The correction has to reach the MODEL, which
 * means it must land in the NEXT request's body. A proxy is stateless across
 * HTTP requests, so the intervention is parked per session and picked up by
 * the next request that resolves the same session key.
 *
 * SESSION KEY
 *
 * The key is the EXISTING session identity resolved by `identity.ts`
 * (`extractExternalSessionId` → `generateSessionId` conversation
 * fingerprint). It is computed ONCE per request, at the request entry, from
 * the client's body BEFORE any governance injection — so injecting the
 * intervention does not change the key the next turn resolves, and the loop
 * breaker's window survives across turns.
 *
 * FORMAT-AWARE INJECTION
 *
 * The synthetic message is a SYSTEM directive, and every source format has a
 * different system carrier:
 *
 *  - OpenAI Chat / Codex : `messages[]` with a `system` role
 *  - Anthropic Messages  : the top-level `system` field
 *  - OpenAI Responses    : `instructions` (a string) — the `input[]` array
 *                          carries conversation items, not the system carrier
 *  - Gemini              : `systemInstruction.parts[]`
 *
 * The injection happens on the CLIENT-FORMAT body, BEFORE translation, so the
 * repo's existing request translators carry the directive into whatever the
 * upstream wire format is (the OpenAI→Claude translator hoists system-role
 * messages into the top-level `system` field, the Responses translator
 * promotes `instructions` into a system item, and so on). No new per-format
 * translation path is introduced.
 *
 * FAIL OPEN
 *
 * A body with no recognisable system carrier is returned UNMODIFIED, and the
 * parked intervention is dropped rather than retried forever. A governance
 * failure must never break the user's request.
 */

import { logger } from "../utils/logger.ts";
import { FORMATS } from "../translator/formats.ts";

const log = logger("GOVERNANCE");

/** Upper bound on parked interventions (LRU eviction). */
export const MAX_INTERVENTION_SESSIONS = 500;

export interface LoopInterventionStoreOptions {
  /** Max parked sessions. Default 500. */
  maxSessions?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

interface ParkedIntervention {
  message: string;
  at: number;
}

/**
 * Bounded, LRU-evicting store of pending loop interventions.
 */
export class LoopInterventionStore {
  private readonly parked = new Map<string, ParkedIntervention>();
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(options: LoopInterventionStoreOptions = {}) {
    this.maxSessions = options.maxSessions ?? MAX_INTERVENTION_SESSIONS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Park an intervention for the next turn of a session.
   *
   * A newer intervention REPLACES an older one for the same session: the
   * latest detection is the most accurate description of the loop.
   */
  register(sessionId: string, message: string): void {
    if (!sessionId || !message) return;
    try {
      if (!this.parked.has(sessionId) && this.parked.size >= this.maxSessions) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, entry] of this.parked) {
          if (entry.at < oldestTime) {
            oldestTime = entry.at;
            oldestKey = key;
          }
        }
        if (oldestKey !== null) this.parked.delete(oldestKey);
      }
      this.parked.set(sessionId, { message, at: this.now() });
    } catch (err) {
      // Fail OPEN: a parking failure must not break the response.
      log.error("failed to park loop intervention (fail-open)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Read the parked intervention WITHOUT consuming it. */
  peek(sessionId: string): string | null {
    try {
      return this.parked.get(sessionId)?.message ?? null;
    } catch {
      return null;
    }
  }

  /** Read AND remove the parked intervention. */
  consume(sessionId: string): string | null {
    try {
      const entry = this.parked.get(sessionId);
      if (!entry) return null;
      this.parked.delete(sessionId);
      return entry.message;
    } catch {
      return null;
    }
  }

  /** Drop a parked intervention without reading it. */
  discard(sessionId: string): void {
    try {
      this.parked.delete(sessionId);
    } catch {
      /* fail-open */
    }
  }

  clear(): void {
    this.parked.clear();
  }

  get size(): number {
    return this.parked.size;
  }
}

/** Process-wide store. */
const globalStore = new LoopInterventionStore();

/** Park an intervention on the process-wide store. */
export function registerLoopIntervention(sessionId: string, message: string): void {
  globalStore.register(sessionId, message);
}

/** Consume an intervention from the process-wide store. */
export function consumeLoopIntervention(sessionId: string): string | null {
  return globalStore.consume(sessionId);
}

/** Peek at the process-wide store. */
export function peekLoopIntervention(sessionId: string): string | null {
  return globalStore.peek(sessionId);
}

/** The process-wide store (tests / ops). */
export function getLoopInterventionStore(): LoopInterventionStore {
  return globalStore;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isSystemRoleMessage(message: unknown): boolean {
  const record = asRecord(message);
  if (!record) return false;
  return record.role === "system" || record.role === "developer";
}

/**
 * Append text to a system message's content, preserving the content shape
 * (string vs block array).
 */
function appendToContent(message: Record<string, unknown>, text: string): void {
  const content = message.content;
  if (Array.isArray(content)) {
    message.content = [...content, { type: "text", text }];
  } else if (typeof content === "string" && content.length > 0) {
    message.content = `${content}\n\n${text}`;
  } else {
    message.content = text;
  }
}

/**
 * Inject a synthetic SYSTEM directive into a CLIENT-FORMAT request body.
 *
 * Returns a NEW body (the input is not mutated). When the body carries no
 * recognisable system carrier the input is returned UNCHANGED — fail OPEN.
 *
 * FORMAT DISPATCH
 *
 * The carrier is chosen from the CLIENT FORMAT when it is known, because the
 * body SHAPES OVERLAP: an Anthropic Messages body carries BOTH `system` and
 * `messages[]`, so a shape-only detector would route it to the OpenAI branch
 * and put the directive into a system-role message the Anthropic translator
 * does not treat as the top-level system prompt. Shape detection is only the
 * fallback for an unknown format.
 */
export function injectGovernanceIntervention<T>(
  body: T,
  message: string,
  sourceFormat?: string | null
): T {
  if (!message) return body;
  const record = asRecord(body);
  if (!record) return body;

  try {
    const carrier = resolveCarrier(record, sourceFormat);

    switch (carrier) {
      case "anthropic":
        return injectIntoAnthropicSystem(record, message) as unknown as T;
      case "responses":
        return injectIntoResponsesInstructions(record, message) as unknown as T;
      case "gemini":
        return injectIntoGeminiSystemInstruction(record, message) as unknown as T;
      case "openai":
        return injectIntoOpenAISystemMessage(record, message) as unknown as T;
      default:
        // No carrier we recognise — fail OPEN, leave the body untouched.
        return body;
    }
  } catch (err) {
    log.error("failed to inject governance intervention (fail-open)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return body;
  }
}

type Carrier = "openai" | "anthropic" | "responses" | "gemini" | "unknown";

/**
 * Resolve which system carrier the body uses.
 *
 * The client format wins when it is known. Otherwise the shape decides, in an
 * order that disambiguates the overlapping shapes:
 *  - `systemInstruction` → Gemini (unique to that format)
 *  - `instructions` → OpenAI Responses
 *  - top-level `system` → Anthropic Messages (its `messages[]` overlap with
 *    OpenAI is resolved in Anthropic's favour)
 *  - `messages[]` → OpenAI Chat / Codex
 */
function resolveCarrier(record: Record<string, unknown>, sourceFormat?: string | null): Carrier {
  if (sourceFormat === FORMATS.CLAUDE) return "anthropic";
  if (sourceFormat === FORMATS.OPENAI_RESPONSES || sourceFormat === FORMATS.OPENAI_RESPONSE) {
    return "responses";
  }
  if (sourceFormat === FORMATS.GEMINI) return "gemini";
  if (sourceFormat === FORMATS.OPENAI || sourceFormat === FORMATS.CODEX) return "openai";

  if (record.systemInstruction !== undefined) return "gemini";
  if (record.instructions !== undefined) return "responses";
  if (record.system !== undefined) return "anthropic";
  if (Array.isArray(record.messages)) return "openai";
  if (Array.isArray(record.input)) return "responses";
  return "unknown";
}

/** OpenAI Chat / Codex: the last `system`/`developer` role message. */
function injectIntoOpenAISystemMessage(
  record: Record<string, unknown>,
  message: string
): Record<string, unknown> {
  const messages = record.messages as Array<Record<string, unknown>>;
  let lastSystemIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isSystemRoleMessage(messages[i])) {
      lastSystemIndex = i;
      break;
    }
  }
  const next = [...messages];
  if (lastSystemIndex >= 0) {
    const target = { ...next[lastSystemIndex] };
    appendToContent(target, message);
    next[lastSystemIndex] = target;
  } else {
    next.push({ role: "system", content: message });
  }
  return { ...record, messages: next };
}

/** Anthropic Messages: the top-level `system` field. */
function injectIntoAnthropicSystem(
  record: Record<string, unknown>,
  message: string
): Record<string, unknown> {
  if (typeof record.system === "string") {
    const system = record.system.length > 0 ? `${record.system}\n\n${message}` : message;
    return { ...record, system };
  }
  if (Array.isArray(record.system)) {
    return {
      ...record,
      system: [...record.system, { type: "text", text: message }],
    };
  }
  return { ...record, system: message };
}

/** OpenAI Responses: the top-level `instructions` string. */
function injectIntoResponsesInstructions(
  record: Record<string, unknown>,
  message: string
): Record<string, unknown> {
  const instructions =
    typeof record.instructions === "string" && record.instructions.length > 0
      ? `${record.instructions}\n\n${message}`
      : message;
  return { ...record, instructions };
}

/** Gemini: `systemInstruction.parts[]`. */
function injectIntoGeminiSystemInstruction(
  record: Record<string, unknown>,
  message: string
): Record<string, unknown> {
  const instruction = asRecord(record.systemInstruction);
  if (!instruction || !Array.isArray(instruction.parts)) return record;
  return {
    ...record,
    systemInstruction: {
      ...instruction,
      parts: [...instruction.parts, { text: message }],
    },
  };
}
