/**
 * Loop breaker — per-session detection of repeated / ping-pong tool calls.
 *
 * WHAT IT DETECTS
 *
 *  - **Repeat**: the same tool called with the same arguments at least
 *    `REPEAT_THRESHOLD` (3) times inside a sliding window of the last
 *    `WINDOW_SIZE` (10) tool calls.
 *  - **Ping-pong**: exactly TWO distinct fingerprints alternating for at least
 *    `PINGPONG_THRESHOLD` (3) cycles inside the same window.
 *
 * WHAT IT DOES (ENFORCING mode — there is NO shadow-mode holding period)
 *
 *  On detection it returns an intervention instructing the caller to inject a
 *  synthetic system message into the NEXT turn's context telling the model to
 *  halt and change approach. The intervention count is tracked PER SESSION; if
 *  the loop persists past `MAX_INTERVENTIONS` (2) the caller is told to hard
 *  abort the stream with a clean finish reason (not a raw connection drop).
 *
 * FINGERPRINT
 *
 *  `sha256(toolName + "\u001f" + canonicalJSON(args))`, computed with the
 *  repo's streaming `jsonSha256` (never `JSON.stringify` on a multi-MB args
 *  object — the #7847 OOM class). The canonical JSON SORTS OBJECT KEYS
 *  RECURSIVELY, so `{a:1,b:2}` and `{b:2,a:1}` fingerprint identically while
 *  any MEANINGFUL argument difference produces a different fingerprint.
 *
 *  COLLISION-RESISTANCE TRADE-OFF (documented deliberately): SHA-256 truncated
 *  to 128 bits is used instead of murmur3. The repo has no murmur3 and adding
 *  one would mean a hand-rolled hash with a correctness risk, for a use case
 *  (detecting accidental repetition) that does not need cryptographic
 *  collision resistance — an adversary would have to craft two different tool
 *  calls with the same 128-bit digest, which is not a realistic threat model
 *  for an accidental-loop detector. The upside is that the fingerprint reuses
 *  the repo's existing, memory-safe, well-tested primitive.
 *
 * FALSE-POSITIVE AVOIDANCE: the fingerprint is over the ACTUAL canonical
 *  arguments, not over the tool name alone, and not over a normalized/
 *  truncated form. Three calls to the same tool with three different argument
 *  sets produce three DIFFERENT fingerprints and do NOT trip the breaker.
 *
 * SESSION KEYING: the session id is the EXISTING session identity (the
 * `sessionManager` fingerprint or `ext:<raw>` external id). The sessionManager
 * maps are in-memory with a 15-minute TTL and a 200-session cap, so state here
 * must tolerate eviction: the per-session map is separately bounded and evicts
 * its own least-recently-used entries.
 */

import { jsonSha256 } from "../utils/jsonHash.ts";
import { canonicalizeJson } from "./auditBus.ts";
import { logger } from "../utils/logger.ts";

const log = logger("GOVERNANCE");

/** Sliding window size — the last N tool calls considered per session. */
export const WINDOW_SIZE = 10;
/** Identical fingerprints inside the window that constitute a loop. */
export const REPEAT_THRESHOLD = 3;
/** Alternating cycles between two distinct fingerprints that constitute a loop. */
export const PINGPONG_THRESHOLD = 3;
/**
 * Interventions tolerated per session before the caller hard-aborts the
 * stream. "Past 2 interventions" ⇒ the 3rd detection escalates.
 */
export const MAX_INTERVENTIONS = 2;
/** Upper bound on tracked sessions (LRU eviction). */
export const MAX_TRACKED_SESSIONS = 500;

/**
 * Resolve whether loop breaking is enabled.
 * Override with `OMNIROUTE_GOVERNANCE_LOOP_ENABLED` ("0" or "false" disables).
 */
export function resolveGovernanceLoopEnabled(): boolean {
  const raw = process.env.OMNIROUTE_GOVERNANCE_LOOP_ENABLED;
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

/**
 * Resolve the threshold of identical fingerprints inside the sliding window that constitute a loop.
 * Override with `OMNIROUTE_GOVERNANCE_LOOP_REPEAT_THRESHOLD` (positive integers only).
 */
export function resolveGovernanceLoopRepeatThreshold(): number {
  const raw = process.env.OMNIROUTE_GOVERNANCE_LOOP_REPEAT_THRESHOLD;
  if (raw === undefined || raw === "") return REPEAT_THRESHOLD;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return REPEAT_THRESHOLD;
  return parsed;
}

/**
 * Resolve the sliding window size for loop breaking.
 * Override with `OMNIROUTE_GOVERNANCE_LOOP_WINDOW_SIZE` (positive integers only).
 */
export function resolveGovernanceLoopWindowSize(): number {
  const raw = process.env.OMNIROUTE_GOVERNANCE_LOOP_WINDOW_SIZE;
  if (raw === undefined || raw === "") return WINDOW_SIZE;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return WINDOW_SIZE;
  return parsed;
}

/**
 * Resolve the threshold of alternating cycles between two fingerprints that constitute a loop.
 * Override with `OMNIROUTE_GOVERNANCE_LOOP_PINGPONG_THRESHOLD` (positive integers only).
 */
export function resolveGovernanceLoopPingpongThreshold(): number {
  const raw = process.env.OMNIROUTE_GOVERNANCE_LOOP_PINGPONG_THRESHOLD;
  if (raw === undefined || raw === "") return PINGPONG_THRESHOLD;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return PINGPONG_THRESHOLD;
  return parsed;
}

/**
 * Resolve the number of loop interventions tolerated per session before hard-aborting.
 * Override with `OMNIROUTE_GOVERNANCE_LOOP_MAX_INTERVENTIONS` (non-negative integers only).
 */
export function resolveGovernanceLoopMaxInterventions(): number {
  const raw = process.env.OMNIROUTE_GOVERNANCE_LOOP_MAX_INTERVENTIONS;
  if (raw === undefined || raw === "") return MAX_INTERVENTIONS;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return MAX_INTERVENTIONS;
  return parsed;
}

/**
 * Resolve whether loop steering (in-stream recovery rather than fatal error abort) is enabled.
 * Override with `OMNIROUTE_GOVERNANCE_LOOP_STEERING` or `OMNIROUTE_GOVERNANCE_STEERING_ENABLED` ("0" or "false" disables).
 * Defaults to true.
 */
export function resolveGovernanceLoopSteeringEnabled(): boolean {
  const raw =
    process.env.OMNIROUTE_GOVERNANCE_LOOP_STEERING ??
    process.env.OMNIROUTE_GOVERNANCE_STEERING_ENABLED;
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

export type LoopKind = "repeat" | "pingpong";

export interface LoopDetection {
  kind: LoopKind;
  /** The offending fingerprint(s) — a digest, never the arguments. */
  fingerprints: string[];
  /** How many times the offending call(s) were seen in the window. */
  count: number;
  /** How many interventions this session has already received. */
  interventions: number;
  /**
   * True when the caller must HARD-ABORT the stream (with a clean
   * `finish_reason`) instead of injecting another intervention message.
   */
  shouldAbort: boolean;
}

export interface LoopBreakerOptions {
  enabled?: boolean;
  windowSize?: number;
  repeatThreshold?: number;
  pingpongThreshold?: number;
  maxInterventions?: number;
  maxSessions?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

interface SessionState {
  /** Rolling window of fingerprints, oldest first. */
  window: string[];
  /** Number of interventions already delivered to this session. */
  interventions: number;
  /** Last-seen timestamp (for LRU eviction). */
  lastActive: number;
}

/**
 * The synthetic system message injected into the next turn's context.
 *
 * Deliberately explicit and self-contained: the model has no memory of the
 * governance layer, so the message states what happened and what to do.
 *
 * The TOOL NAME is included — the detector only carries a fingerprint (a
 * digest), never the arguments, so the caller supplies the name of the tool
 * that was repeated. Naming it lets the model recognise which action to stop,
 * which is the whole point of the intervention.
 */
export function buildLoopInterventionMessage(detection: LoopDetection, toolName?: string): string {
  const named = toolName ? `The action in question is the "${toolName}" tool.` : "";
  if (detection.kind === "pingpong") {
    return (
      `You have invoked two actions in an alternating loop for ${detection.count} cycles with ` +
      `identical results. ${named}` +
      `Halt this approach. Do not repeat either action again. ` +
      `Change strategy: use the information you already have, try a materially different ` +
      `action, or finish the task and report your findings.`
    );
  }
  return (
    `You have invoked this exact action ${detection.count} times with identical results. ${named}` +
    `Halt this approach. Do not invoke it again with the same arguments. ` +
    `Change strategy: use the information you already have, try a materially different ` +
    `action, or finish the task and report your findings.`
  );
}

/**
 * The in-stream steering directive emitted to the client when a loop is detected.
 *
 * Formatted as an authoritative assistant steering directive with a clean normal finish reason
 * (e.g. `end_turn` for Claude or `stop` for OpenAI), allowing autonomous agents to immediately
 * recover and pivot without crashing with an unrecoverable API Error.
 */
export function buildLoopSteeringDirective(detection: LoopDetection, toolName?: string): string {
  const named = toolName ? `("${toolName}") ` : "";
  if (detection.kind === "pingpong") {
    return (
      `[Governance Steering Directive: An alternating action loop was detected between tools over ${detection.count} cycles with identical results. ` +
      `Halting repetitive execution. Do not repeat this sequence. ` +
      `Immediately change strategy: summarize your progress so far, use the data already acquired, try a fundamentally different approach, or report your final response.]`
    );
  }
  return (
    `[Governance Steering Directive: A repetitive loop was detected: the action ${named}was repeated ${detection.count} times with identical arguments and results. ` +
    `Halting repetitive execution. Do not invoke this action again with the same parameters. ` +
    `Immediately change strategy: analyze previous outputs, try a fundamentally different approach, or conclude your work and report the final outcome.]`
  );
}

/**
 * Compute the fingerprint of one tool call.
 *
 * `toolName` + US (\u001f) + canonical JSON of the arguments.
 */
export function fingerprintToolCall(toolName: string, args: unknown): string {
  const canonical = jsonSha256(canonicalizeJson(args ?? null));
  return jsonSha256(`${toolName}\u001f${canonical}`);
}

/**
 * Per-session loop detection with a bounded sliding window.
 */
export class LoopBreaker {
  private readonly sessions = new Map<string, SessionState>();
  private readonly enabled: boolean;
  private readonly windowSize: number;
  private readonly repeatThreshold: number;
  private readonly pingpongThreshold: number;
  private readonly maxInterventions: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(options: LoopBreakerOptions = {}) {
    this.enabled = options.enabled ?? resolveGovernanceLoopEnabled();
    this.windowSize = options.windowSize ?? resolveGovernanceLoopWindowSize();
    this.repeatThreshold = options.repeatThreshold ?? resolveGovernanceLoopRepeatThreshold();
    this.pingpongThreshold = options.pingpongThreshold ?? resolveGovernanceLoopPingpongThreshold();
    this.maxInterventions = options.maxInterventions ?? resolveGovernanceLoopMaxInterventions();
    this.maxSessions = options.maxSessions ?? MAX_TRACKED_SESSIONS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Observe one tool call for a session.
   *
   * Returns a `LoopDetection` when a loop is detected, otherwise null. On
   * detection the session's intervention counter is incremented — the caller is
   * expected to inject the intervention message (or abort, per
   * `shouldAbort`) so the counter tracks interventions DELIVERED.
   */
  observe(sessionId: string, toolName: string, args: unknown): LoopDetection | null {
    try {
      return this.observeInternal(sessionId, toolName, args);
    } catch (err) {
      // Fail OPEN: a governance internal error must never break the request.
      log.error("loop breaker observe failed; passing through (fail-open)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private observeInternal(
    sessionId: string,
    toolName: string,
    args: unknown
  ): LoopDetection | null {
    if (!this.enabled || !sessionId) return null;
    const fingerprint = fingerprintToolCall(toolName, args);

    let state = this.sessions.get(sessionId);
    if (!state) {
      this.evictIfNeeded();
      state = { window: [], interventions: 0, lastActive: this.now() };
      this.sessions.set(sessionId, state);
    }
    state.lastActive = this.now();

    state.window.push(fingerprint);
    if (state.window.length > this.windowSize) {
      state.window.splice(0, state.window.length - this.windowSize);
    }

    const detection = this.detectInWindow(state.window);
    if (!detection) return null;

    state.interventions += 1;
    const full: LoopDetection = {
      ...detection,
      interventions: state.interventions,
      // "Persists past 2 interventions" ⇒ the 3rd detection hard-aborts.
      shouldAbort: state.interventions > this.maxInterventions,
    };
    return full;
  }

  /**
   * Pure window analysis — exported for tests.
   *
   * ORDER MATTERS: ping-pong is checked FIRST because it is the more specific
   * signal. A ping-pong `A,B,A,B,A` also contains A three times, so a
   * repeat-first order would misreport it as a plain repeat and lose the
   * ping-pong classification.
   */
  detectInWindow(
    window: readonly string[]
  ): Omit<LoopDetection, "interventions" | "shouldAbort"> | null {
    if (window.length === 0) return null;

    // ── Ping-pong: a strictly alternating tail over exactly two fingerprints ──
    // A "cycle" is one transition between the two fingerprints, so >= 3 cycles
    // means >= 3 transitions, i.e. an alternating run of at least 4 calls
    // (A,B,A,B). The run is the longest STRICTLY alternating suffix of the
    // window — a session may legitimately have made other calls earlier and
    // only then fallen into a ping-pong.
    const pingpong = this.detectPingpong(window);
    if (pingpong) return pingpong;

    // ── Repeat: the current fingerprint occurred at least `repeatThreshold` times ──
    // Counted across the whole sliding window, but strictly anchored to the CURRENT
    // action (window tail). If the model pivots to a different tool (such as writing
    // a document or taking a new action), prior repeated calls must not falsely accuse
    // the new action of repeating.
    const currentFingerprint = window[window.length - 1];
    let count = 0;
    for (const fingerprint of window) {
      if (fingerprint === currentFingerprint) {
        count += 1;
      }
    }
    if (count >= this.repeatThreshold) {
      return { kind: "repeat", fingerprints: [currentFingerprint], count };
    }

    return null;
  }

  /**
   * Longest strictly-alternating suffix over exactly two distinct
   * fingerprints, if it carries at least `pingpongThreshold` transitions.
   */
  private detectPingpong(
    window: readonly string[]
  ): { kind: "pingpong"; fingerprints: string[]; count: number } | null {
    if (window.length < this.pingpongThreshold + 1) return null;

    // Walk backwards while the run stays strictly alternating AND keeps
    // covering exactly two distinct fingerprints.
    const run: string[] = [window[window.length - 1]];
    for (let i = window.length - 2; i >= 0; i--) {
      if (window[i] === window[i - 1]) break; // adjacent duplicates end the run
      run.push(window[i]);
      const distinct = new Set(run);
      if (distinct.size > 2) break; // a third fingerprint ends the ping-pong
    }
    if (run.length < 2) return null;

    const distinct = Array.from(new Set(run));
    if (distinct.length !== 2) return null;

    // `run.length - 1` transitions = cycles.
    const cycles = run.length - 1;
    if (cycles < this.pingpongThreshold) return null;

    return { kind: "pingpong", fingerprints: distinct, count: cycles };
  }

  /** Interventions already delivered to a session. */
  getInterventionCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.interventions ?? 0;
  }

  /** Clear sliding window for a session (e.g. upon active steering or intervention). */
  clearWindow(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.window = [];
    }
  }

  /** Reset interventions count for a session. */
  resetInterventions(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.interventions = 0;
    }
  }

  /** Forget a session (e.g. on explicit teardown). */
  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Forget every session. */
  resetAll(): void {
    this.sessions.clear();
  }

  /** Number of tracked sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Evict the least-recently-active session when over the cap. */
  private evictIfNeeded(): void {
    if (this.sessions.size < this.maxSessions) return;
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, state] of this.sessions) {
      if (state.lastActive < oldestTime) {
        oldestTime = state.lastActive;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.sessions.delete(oldestKey);
  }
}

/** Process-wide default breaker. */
const globalBreaker = new LoopBreaker();

/**
 * The process-wide breaker.
 *
 * The breaker instance IS the API: `observe()` detects a loop and
 * `getInterventionCount()` reports how many interventions a session has
 * received. A separate module-level wrapper for either would be a second way
 * to reach the same state, and the repo's dead-export gate treats an unused
 * wrapper as dead code.
 */
export function getLoopBreaker(): LoopBreaker {
  return globalBreaker;
}
