/**
 * Token sentinel — per-stream reasoning-token accounting and velocity.
 *
 * WHAT IT TRACKS
 *
 *  1. **Cumulative reasoning/thinking tokens** for one in-flight stream.
 *  2. **Token emission velocity** — a rolling tokens/second over the last
 *     2 seconds.
 *
 * REASONING FIELD NAMES — VERIFIED AGAINST THE TRANSLATORS
 *
 *  The client-facing wire formats the repo's translators actually emit:
 *
 *  - `delta.reasoning_content` — the dominant field. Emitted by
 *    `open-sse/translator/response/claude-to-openai.ts` (from Claude
 *    `thinking_delta`), by `open-sse/translator/response/openai-responses.ts`
 *    (`response.reasoning_content_text.delta` / `response.reasoning_text.delta`
 *    / `response.reasoning_summary_text.delta`), and by
 *    `open-sse/translator/response/gemini-to-openai.ts` (native thinking parts
 *    and textual `<think>` wrappers).
 *  - `delta.reasoning_text` — the Copilot-compatible variant of the same
 *    field (`open-sse/translator/response/openai-responses.ts`
 *    `buildResponsesReasoningDeltaChunk`).
 *  - `delta.reasoning` — the alias some upstreams use (read by
 *    `open-sse/translator/response/openai-to-claude.ts`).
 *  - `delta.reasoning_details[]` — an array form (StepFun/OpenRouter), read by
 *    `open-sse/translator/response/openai-to-claude.ts`.
 *  - Anthropic-native `delta.thinking` (Claude → Anthropic passthrough) and
 *    `content_block.thinking`.
 *
 *  All of the above are supported.
 *
 *  IMPORTANT SCOPE NOTE: this sentinel runs on the CLIENT-FACING stream (the
 *  egress tap), so it counts the reasoning tokens the CLIENT receives, which
 *  is the format-normalized `reasoning_content`/`reasoning_text`/`reasoning`
 *  family. The upstream-native `delta.thinking` / `content_block.thinking`
 *  shapes are counted when they reach the tap unchanged (Claude passthrough),
 *  but a provider-native thinking block that the translator has already mapped
 *  into `reasoning_content` is counted under that name.
 *
 * CEILING
 *
 *  Default 16 000 reasoning tokens, configurable. On breach the sentinel asks
 *  the caller to terminate the stream with a CLEAN FINISH (a well-formed
 *  terminal frame the client-side agent can read as a proper `finish_reason`)
 *  — NOT a raw connection drop.
 *
 * TRACKER LIFECYCLE
 *
 *  A tracker is created per in-flight stream and MUST be released on
 *  abnormal close / cancel / error. The sentinel keeps a registry of live
 *  trackers so a leak is observable (`liveTokenSentinelCount()`),
 *  and `releaseTracker` is idempotent so a double-release cannot corrupt the
 *  registry.
 *
 * TOKEN ESTIMATION
 *
 *  Reasoning tokens are not reported per delta by the providers, so the
 *  sentinel estimates them from the text: ~4 characters per token is the
 *  standard English approximation. This is an ESTIMATE, and is documented as
 *  such — it is a ceiling on an approximation, so it is deliberately
 *  conservative (it errs on the side of not tripping).
 */

import { logger } from "../utils/logger.ts";
import { recordGovernanceAudit } from "./auditBus.ts";

const log = logger("GOVERNANCE");

/** Default ceiling on cumulative reasoning tokens per stream. */
export const DEFAULT_REASONING_TOKEN_CEILING = 16_000;

/**
 * Resolve the operator-configured reasoning-token ceiling.
 *
 * Override with `OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING` (positive
 * integers only). A non-numeric, zero or negative value falls back to the
 * default rather than disabling the guard.
 */
export function resolveGovernanceReasoningCeiling(): number {
  const raw = process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING;
  if (raw === undefined || raw === "") return DEFAULT_REASONING_TOKEN_CEILING;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REASONING_TOKEN_CEILING;
  return parsed;
}
/** Velocity window in milliseconds. */
export const VELOCITY_WINDOW_MS = 2_000;
/** Approximate characters per token used for the reasoning-token estimate. */
export const CHARS_PER_TOKEN = 4;
/**
 * Default velocity ceiling in tokens/second. `null` disables the velocity
 * check — the cumulative ceiling is the primary signal.
 */
export const DEFAULT_VELOCITY_CEILING: number | null = null;

/**
 * The reasoning-bearing field names supported on the client-facing wire.
 * Every variant the repo's translators actually emit is listed here.
 */
export const REASONING_FIELDS = ["reasoning_content", "reasoning_text", "reasoning"] as const;

export interface TokenSentinelOptions {
  /** Cumulative reasoning-token ceiling. Default 16 000. */
  ceiling?: number;
  /** Velocity ceiling in tokens/second. `null` disables. */
  velocityCeiling?: number | null;
  /** Velocity window in ms. Default 2 000. */
  velocityWindowMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface TokenSentinelBreach {
  kind: "ceiling" | "velocity" | "repetition";
  /** Cumulative reasoning tokens at breach time. */
  cumulativeTokens: number;
  /** Tokens/second over the velocity window (velocity breaches only). */
  velocity: number;
  /** The configured limit that was crossed. */
  limit: number;
  /** A client-safe, human-readable reason. */
  message: string;
}

/** One sample in the rolling velocity window. */
interface VelocitySample {
  at: number;
  tokens: number;
}

/**
 * Detect degenerate token / phrase repetition loops in model text (stuttering, runaway loops).
 */
export function detectDegenerateRepetition(text: string): { detected: boolean; reason?: string } {
  if (!text || text.length < 35) return { detected: false };

  const words = text.trim().split(/\s+/).slice(-80);
  if (words.length < 5) return { detected: false };

  // 1. Runaway single-word repetition (e.g. "wait wait wait wait wait wait")
  if (words.length >= 6) {
    const lastWord = words[words.length - 1].toLowerCase().replace(/[^a-z0-9]/g, "");
    if (lastWord.length >= 2) {
      let run = 0;
      for (let i = words.length - 1; i >= 0; i--) {
        const w = words[i].toLowerCase().replace(/[^a-z0-9]/g, "");
        if (w === lastWord) run++;
        else break;
      }
      if (run >= 6) {
        return { detected: true, reason: `runaway_word_repeat ("${lastWord}" x ${run})` };
      }
    }
  }

  // 2. Word-level stuttering (consecutive identical words in stream)
  let stutterCount = 0;
  for (let i = 1; i < words.length; i++) {
    const w1 = words[i - 1].toLowerCase().replace(/[^a-z0-9]/g, "");
    const w2 = words[i].toLowerCase().replace(/[^a-z0-9]/g, "");
    if (w1.length >= 2 && w1 === w2) {
      stutterCount++;
    }
  }
  if (stutterCount >= 4) {
    return { detected: true, reason: `word_stuttering (${stutterCount} stutter pairs)` };
  }

  // 3. Multi-word phrase repetition cycle (k words repeated 3+ times consecutively)
  for (let k = 3; k <= 25; k++) {
    if (words.length < k * 3) break;
    const g1 = words.slice(-k).join(" ").toLowerCase();
    const g2 = words
      .slice(-k * 2, -k)
      .join(" ")
      .toLowerCase();
    const g3 = words
      .slice(-k * 3, -k * 2)
      .join(" ")
      .toLowerCase();
    if (g1 === g2 && g2 === g3) {
      const clean = g1.replace(/[^a-z0-9]/g, "");
      if (clean.length >= 8) {
        return {
          detected: true,
          reason: `phrase_repetition_cycle ("${words.slice(-k).join(" ").slice(0, 35)}...")`,
        };
      }
    }
  }

  return { detected: false };
}

export class TokenSentinelTracker {
  private cumulativeTokens = 0;
  private readonly samples: VelocitySample[] = [];
  private readonly ceiling: number;
  private readonly velocityCeiling: number | null;
  private readonly velocityWindowMs: number;
  private readonly now: () => number;
  private recentTextTail = "";
  private released = false;
  private breached = false;

  constructor(options: TokenSentinelOptions = {}) {
    this.ceiling = options.ceiling ?? DEFAULT_REASONING_TOKEN_CEILING;
    this.velocityCeiling =
      options.velocityCeiling === undefined ? DEFAULT_VELOCITY_CEILING : options.velocityCeiling;
    this.velocityWindowMs = options.velocityWindowMs ?? VELOCITY_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Cumulative reasoning tokens observed so far. */
  get cumulative(): number {
    return this.cumulativeTokens;
  }

  /** Tokens/second over the rolling window. */
  get velocity(): number {
    return this.computeVelocity();
  }

  /** True once a breach has been reported for this stream. */
  get didBreach(): boolean {
    return this.breached;
  }

  /**
   * Observe stream text (content or reasoning) for degenerate repetition and accounting.
   */
  observeText(text: string, isReasoning = false): TokenSentinelBreach | null {
    if (this.released) return null;
    if (this.breached) return null;
    if (typeof text !== "string" || text.length === 0) return null;

    // Check for degenerate repetition across accumulated stream text
    this.recentTextTail = (this.recentTextTail + text).slice(-1500);
    const rep = detectDegenerateRepetition(this.recentTextTail);
    if (rep.detected) {
      this.breached = true;
      return {
        kind: "repetition",
        cumulativeTokens: this.cumulativeTokens,
        velocity: this.computeVelocity(),
        limit: 0,
        message:
          `Degenerate repetition loop detected in model output (${rep.reason}). ` +
          `The stream was stopped to bound token waste.`,
      };
    }

    if (isReasoning) {
      const tokens = Math.ceil(text.length / CHARS_PER_TOKEN);
      if (tokens <= 0) return null;

      this.cumulativeTokens += tokens;
      const now = this.now();
      this.samples.push({ at: now, tokens });
      this.pruneSamples(now);

      if (this.cumulativeTokens >= this.ceiling) {
        this.breached = true;
        return {
          kind: "ceiling",
          cumulativeTokens: this.cumulativeTokens,
          velocity: this.computeVelocity(),
          limit: this.ceiling,
          message:
            `Reasoning token ceiling reached (${this.cumulativeTokens} of ${this.ceiling}). ` +
            `The stream was stopped to bound the request cost.`,
        };
      }

      if (this.velocityCeiling !== null) {
        const velocity = this.computeVelocity();
        if (velocity >= this.velocityCeiling) {
          this.breached = true;
          return {
            kind: "velocity",
            cumulativeTokens: this.cumulativeTokens,
            velocity,
            limit: this.velocityCeiling,
            message:
              `Reasoning token emission rate exceeded the configured limit ` +
              `(${velocity.toFixed(1)} tokens/s of ${this.velocityCeiling}). ` +
              `The stream was stopped to bound the request cost.`,
          };
        }
      }
    }

    return null;
  }

  /**
   * Account for one reasoning delta.
   *
   * Returns a breach descriptor the first time a limit is crossed, and null
   * afterwards (a stream reports at most one breach).
   */
  observeReasoningText(text: string): TokenSentinelBreach | null {
    return this.observeText(text, true);
  }

  /** Drop samples older than the velocity window. */
  private pruneSamples(now: number): void {
    const cutoff = now - this.velocityWindowMs;
    while (this.samples.length > 0 && this.samples[0].at < cutoff) {
      this.samples.shift();
    }
  }

  /** Rolling tokens/second over the velocity window. */
  private computeVelocity(): number {
    const now = this.now();
    this.pruneSamples(now);
    if (this.samples.length === 0) return 0;
    const total = this.samples.reduce((sum, sample) => sum + sample.tokens, 0);
    // The window is the elapsed time between the oldest sample and now, floored
    // at the window width so a burst in the first millisecond does not divide by
    // ~0 and report an absurd rate.
    const oldest = this.samples[0].at;
    const elapsed = Math.max(now - oldest, this.velocityWindowMs);
    return (total / elapsed) * 1000;
  }

  /** Mark the tracker released. Idempotent. */
  release(): void {
    this.released = true;
    this.samples.length = 0;
  }

  /** True once released. */
  get isReleased(): boolean {
    return this.released;
  }
}

export interface TokenSentinelContext {
  sessionId: string;
  principalId?: string;
  requestId?: string;
  model?: string;
  provider?: string;
  turnIndex?: number;
  promptHash?: string;
}

/** Push a non-empty string into the accumulator. */
function pushText(out: string[], value: unknown): void {
  if (typeof value === "string" && value.length > 0) out.push(value);
}

/**
 * Extract the reasoning text carried by ONE delta object.
 *
 * Covers the OpenAI-shaped scalar fields (`reasoning_content`,
 * `reasoning`), the Anthropic-native `thinking` delta, and the array form
 * `reasoning_details[]` (StepFun / OpenRouter).
 */
function collectDeltaReasoning(delta: unknown, out: string[]): void {
  if (!delta || typeof delta !== "object") return;
  const d = delta as Record<string, unknown>;

  for (const field of REASONING_FIELDS) {
    pushText(out, d[field]);
  }
  // Anthropic-native thinking delta.
  pushText(out, d.thinking);

  // Array form: reasoning_details[] (StepFun / OpenRouter).
  const details = d.reasoning_details;
  if (!Array.isArray(details)) return;
  for (const entry of details) {
    if (typeof entry === "string") {
      pushText(out, entry);
      continue;
    }
    if (entry && typeof entry === "object") {
      pushText(out, (entry as Record<string, unknown>).text);
    }
  }
}

/**
 * Extract every reasoning delta from one client-facing SSE chunk.
 *
 * Handles the OpenAI Chat shape (`choices[].delta.*`), the Anthropic shape
 * (`delta.thinking` / `content_block.thinking`), and the Responses shape
 * (`delta.reasoning_content` at the top level of a `response.*` event).
 */
export function extractReasoningText(chunk: unknown): string[] {
  const out: string[] = [];
  if (!chunk || typeof chunk !== "object") return out;
  const record = chunk as Record<string, unknown>;

  // Anthropic: {type:"content_block_delta", delta:{type:"thinking_delta", thinking}}
  collectDeltaReasoning(record.delta, out);
  // Anthropic: {type:"content_block_start", content_block:{type:"thinking", thinking}}
  const contentBlock = record.content_block;
  if (contentBlock && typeof contentBlock === "object") {
    pushText(out, (contentBlock as Record<string, unknown>).thinking);
  }

  // OpenAI Chat: choices[].delta
  const choices = record.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      collectDeltaReasoning((choice as Record<string, unknown>).delta, out);
    }
  }

  // Responses: {type:"response.reasoning_content_text.delta", delta:"text"}
  if (typeof record.delta === "string" && typeof record.type === "string") {
    if (record.type.includes("reasoning")) pushText(out, record.delta);
  }

  return out;
}

/**
 * Extract stream text deltas (both reasoning text and output content text).
 */
export function extractStreamTexts(chunk: unknown): { text: string; isReasoning: boolean }[] {
  const out: { text: string; isReasoning: boolean }[] = [];
  if (!chunk || typeof chunk !== "object") return out;
  const record = chunk as Record<string, unknown>;

  // Reasoning text
  const reasoningTexts = extractReasoningText(chunk);
  for (const t of reasoningTexts) {
    out.push({ text: t, isReasoning: true });
  }

  // Anthropic content delta: {type:"content_block_delta", delta:{type:"text_delta", text}}
  const delta = record.delta as Record<string, unknown> | undefined;
  if (
    delta &&
    typeof delta === "object" &&
    typeof delta.text === "string" &&
    delta.type === "text_delta"
  ) {
    out.push({ text: delta.text, isReasoning: false });
  }

  // OpenAI Chat content: choices[].delta.content
  const choices = record.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const d = (choice as Record<string, unknown>).delta as Record<string, unknown> | undefined;
      if (d && typeof d.content === "string") {
        out.push({ text: d.content, isReasoning: false });
      }
    }
  }

  // Responses: {type:"response.output_text.delta", delta:"text"}
  if (
    typeof record.delta === "string" &&
    typeof record.type === "string" &&
    record.type.includes("output_text")
  ) {
    out.push({ text: record.delta, isReasoning: false });
  }

  return out;
}

/**
 * Per-stream registry of live trackers.
 *
 * Exists so a mid-stream disconnect that skips `release()` is OBSERVABLE
 * (`liveTrackers` count) rather than an invisible leak.
 */
const liveTrackers = new Set<TokenSentinelTracker>();

/** Create a tracker and register it as live. */
export function createTokenSentinelTracker(
  options: TokenSentinelOptions = {}
): TokenSentinelTracker {
  const tracker = new TokenSentinelTracker(options);
  liveTrackers.add(tracker);
  return tracker;
}

/**
 * Release a tracker. Idempotent — a double release cannot corrupt the
 * registry. Returns true when this call actually released it.
 */
export function releaseTokenSentinelTracker(
  tracker: TokenSentinelTracker | null | undefined
): boolean {
  if (!tracker) return false;
  const wasLive = liveTrackers.delete(tracker);
  tracker.release();
  return wasLive;
}

/** Number of trackers still considered live (a leak would show here). */
export function liveTokenSentinelCount(): number {
  return liveTrackers.size;
}

/** Release every live tracker (tests / shutdown). */
export function releaseAllTokenSentinelTrackers(): void {
  for (const tracker of liveTrackers) tracker.release();
  liveTrackers.clear();
}

/**
 * Audit a token-ceiling breach. Fire-and-forget; never throws.
 */
export function auditTokenBreach(breach: TokenSentinelBreach, context: TokenSentinelContext): void {
  try {
    recordGovernanceAudit({
      sessionId: context.sessionId,
      turnIndex: context.turnIndex ?? 0,
      promptHash: context.promptHash ?? "",
      toolCallsRequested: [],
      toolCallsExecuted: [],
      tokensIn: 0,
      tokensOut: breach.cumulativeTokens,
      model: context.model ?? "",
      provider: context.provider ?? "",
      compressionApplied: false,
      ...(context.principalId !== undefined ? { principalId: context.principalId } : {}),
      ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
      event: "token_sentinel.breach",
      details: {
        kind: breach.kind,
        cumulativeTokens: breach.cumulativeTokens,
        limit: breach.limit,
      },
    });
  } catch (err) {
    log.error("audit of token breach failed (fail-open)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
