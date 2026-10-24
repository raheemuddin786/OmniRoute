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
/**
 * Repeat threshold for safe read-only operations (file reading, directory inspection, grep).
 * Agents legitimately read the same configuration or status multiple times during a workflow.
 */
export const READONLY_REPEAT_THRESHOLD = 5;
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
 * Resolve the repeat threshold for idempotent read-only tool calls.
 * Override with `OMNIROUTE_GOVERNANCE_LOOP_READONLY_REPEAT_THRESHOLD` (positive integers only).
 */
export function resolveGovernanceLoopReadonlyRepeatThreshold(): number {
  const raw = process.env.OMNIROUTE_GOVERNANCE_LOOP_READONLY_REPEAT_THRESHOLD;
  if (raw === undefined || raw === "") return READONLY_REPEAT_THRESHOLD;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return READONLY_REPEAT_THRESHOLD;
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

/**
 * Known read-only or inspection tool names and patterns.
 * Agents legitimately call these repeatedly during standard exploration, planning,
 * reading code, inspecting logs, or checking task/build statuses.
 */
const KNOWN_READONLY_EXACT = new Set([
  "read",
  "read_file",
  "readfile",
  "view_file",
  "viewfile",
  "view",
  "cat",
  "grep",
  "grep_search",
  "grepsearch",
  "search",
  "search_files",
  "filesearch",
  "list_dir",
  "listdir",
  "list_directory",
  "ls",
  "dir",
  "search_web",
  "web_search",
  "read_url_content",
  "read_browser_page",
  "fetch_url",
  "status",
  "git_status",
  "task_status",
  "get_task",
]);

const READONLY_PREFIXES = [
  "read_",
  "view_",
  "list_",
  "search_",
  "get_",
  "inspect_",
  "check_",
  "describe_",
  "show_",
  "find_",
  "fetch_",
];

const READONLY_SUFFIXES = ["_read", "_view", "_search", "_status", "_list", "_info"];

export function isReadOnlyOrInspectionTool(toolName?: string, args?: unknown): boolean {
  if (!toolName || typeof toolName !== "string") return false;
  const normalized = toolName.trim().toLowerCase();

  // Special-case tool inspection (e.g. manage_task with status/list action)
  if (normalized === "manage_task" && args && typeof args === "object") {
    const action = String(
      (args as Record<string, unknown>).Action ?? (args as Record<string, unknown>).action ?? ""
    ).toLowerCase();
    return action === "status" || action === "list";
  }

  if (KNOWN_READONLY_EXACT.has(normalized)) return true;

  for (const prefix of READONLY_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }

  for (const suffix of READONLY_SUFFIXES) {
    if (normalized.endsWith(suffix)) return true;
  }

  return false;
}

const KNOWN_MUTATING_EXACT = new Set([
  "write",
  "write_file",
  "write_to_file",
  "writetofile",
  "edit",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
  "delete_file",
  "rm",
  "apply_patch",
  "patch",
  "run_command",
  "bash",
  "terminal",
  "exec",
  "execute",
  "execute_command",
]);

const MUTATING_PREFIXES = [
  "write_",
  "edit_",
  "replace_",
  "multi_replace_",
  "create_",
  "update_",
  "delete_",
  "remove_",
  "insert_",
  "modify_",
  "post_",
  "put_",
  "patch_",
];

export function isMutatingTool(toolName?: string, args?: unknown): boolean {
  if (!toolName || typeof toolName !== "string") return false;
  const normalized = toolName.trim().toLowerCase();

  if (normalized === "manage_task" && args && typeof args === "object") {
    const action = String(
      (args as Record<string, unknown>).Action ?? (args as Record<string, unknown>).action ?? ""
    ).toLowerCase();
    return action === "kill" || action === "send_input";
  }

  if (KNOWN_MUTATING_EXACT.has(normalized)) return true;

  for (const prefix of MUTATING_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }

  return false;
}

export type LoopKind = "repeat" | "pingpong" | "polymorphic_repeat" | "unknown_tool_loop";

export interface LoopDetection {
  kind: LoopKind;
  /** The offending fingerprint(s) — a digest or tool names, never the arguments. */
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
  readonlyRepeatThreshold?: number;
  pingpongThreshold?: number;
  maxInterventions?: number;
  maxSessions?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface WindowEntry {
  fingerprint: string;
  toolName?: string;
  args?: unknown;
  requestId?: string;
}

export interface RejectionRecord {
  toolName: string;
  reason: string;
  at: number;
  requestId?: string;
}

interface SessionState {
  /** Rolling window of tool calls. */
  window: WindowEntry[];
  /** Rolling window of recent tool rejections. */
  rejections: RejectionRecord[];
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
function sanitizeToolName(name?: string): string {
  if (!name || typeof name !== "string") return "";
  return name.replace(/[^\w.:\/-]/g, "_").slice(0, 80);
}

export function buildLoopInterventionMessage(detection: LoopDetection, toolName?: string): string {
  const safeName = sanitizeToolName(toolName);
  const named = safeName ? `The action in question is the "${safeName}" tool.` : "";
  if (detection.kind === "pingpong") {
    return (
      `You have invoked two actions in an alternating loop for ${detection.count} cycles with ` +
      `identical results. ${named}` +
      `Halt this approach. Do not repeat either action again. ` +
      `Change strategy: use the information you already have, try a materially different ` +
      `action, or finish the task and report your findings.`
    );
  }
  if (detection.kind === "polymorphic_repeat") {
    return (
      `The tool "${safeName}" has been called repeatedly and rejected ${detection.count} times. ` +
      `Halt this approach. Do not attempt to invoke "${safeName}" again. ` +
      `Change strategy: use only valid tools registered in your context catalog, ` +
      `or finish your task and report your findings.`
    );
  }
  if (detection.kind === "unknown_tool_loop") {
    return (
      `Multiple non-existent tools have been requested and rejected ${detection.count} times. ` +
      `Halt this approach. Stop inventing new tool names. ` +
      `Change strategy: review the tool catalog provided in your context and use only declared tools, ` +
      `or finish your task and report your findings.`
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
  const safeName = sanitizeToolName(toolName);
  const named = safeName ? `("${safeName}") ` : "";
  if (detection.kind === "pingpong") {
    return (
      `[Governance Steering Directive: An alternating action loop was detected between tools over ${detection.count} cycles with identical results. ` +
      `Halting repetitive execution. Do not repeat this sequence. ` +
      `Immediately change strategy: summarize your progress so far, use the data already acquired, try a fundamentally different approach, or report your final response.]`
    );
  }
  if (detection.kind === "polymorphic_repeat") {
    return (
      `[Governance Steering Directive: Tool "${safeName}" has been called repeatedly and rejected ${detection.count} times. ` +
      `Halting repeated attempts. Do not call "${safeName}" again. ` +
      `Immediately change strategy: use only tools declared in the active catalog, or conclude and report your final summary.]`
    );
  }
  if (detection.kind === "unknown_tool_loop") {
    return (
      `[Governance Steering Directive: Multiple tool calls (${detection.count}) were rejected because the requested tools are not declared in the tool catalog. ` +
      `Halting unknown tool generation. Do not invent new tool names. ` +
      `Immediately change strategy: consult the declared tools in your context and use only available tools, or conclude your work.]`
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
  private readonly readonlyRepeatThreshold: number;
  private readonly pingpongThreshold: number;
  private readonly maxInterventions: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(options: LoopBreakerOptions = {}) {
    this.enabled = options.enabled ?? resolveGovernanceLoopEnabled();
    this.windowSize = options.windowSize ?? resolveGovernanceLoopWindowSize();
    this.repeatThreshold = options.repeatThreshold ?? resolveGovernanceLoopRepeatThreshold();
    this.readonlyRepeatThreshold =
      options.readonlyRepeatThreshold ??
      (options.repeatThreshold !== undefined
        ? options.repeatThreshold
        : resolveGovernanceLoopReadonlyRepeatThreshold());
    this.pingpongThreshold = options.pingpongThreshold ?? resolveGovernanceLoopPingpongThreshold();
    this.maxInterventions = options.maxInterventions ?? resolveGovernanceLoopMaxInterventions();
    this.maxSessions = options.maxSessions ?? MAX_TRACKED_SESSIONS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Observe one tool call for a session.
   *
   * Returns a `LoopDetection` when a loop is detected, otherwise null. On
   * detection the session's intervention counter is incremented and the caller is
   * expected to inject the intervention message (or abort, per
   * `shouldAbort`) so the counter tracks interventions DELIVERED.
   */
  observe(
    sessionId: string,
    toolName: string,
    args: unknown,
    requestId?: string
  ): LoopDetection | null {
    try {
      return this.observeInternal(sessionId, toolName, args, requestId);
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
    args: unknown,
    requestId?: string
  ): LoopDetection | null {
    if (!this.enabled || !sessionId) return null;
    const fingerprint = fingerprintToolCall(toolName, args);

    let state = this.sessions.get(sessionId);
    if (!state) {
      this.evictIfNeeded();
      state = { window: [], rejections: [], interventions: 0, lastActive: this.now() };
      this.sessions.set(sessionId, state);
    }
    state.lastActive = this.now();

    state.window.push({ fingerprint, toolName, args, requestId });
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
    window: readonly (string | WindowEntry)[]
  ): Omit<LoopDetection, "interventions" | "shouldAbort"> | null {
    if (window.length === 0) return null;

    const normalized: WindowEntry[] = window.map((e) =>
      typeof e === "string" ? { fingerprint: e } : e
    );

    // ── Ping-pong: a strictly alternating tail over exactly two fingerprints ──
    // A "cycle" is one transition between the two fingerprints, so >= 3 cycles
    // means >= 3 transitions, i.e. an alternating run of at least 4 calls
    // (A,B,A,B). The run is the longest STRICTLY alternating suffix of the
    // window — a session may legitimately have made other calls earlier and
    // only then fallen into a ping-pong.
    const pingpong = this.detectPingpong(normalized);
    if (pingpong) return pingpong;

    // ── Repeat: the current fingerprint occurred at least the effective repeat threshold ──
    // Counted across the sliding window, but strictly anchored to the CURRENT action (window tail).
    // For read-only/inspection tools (Read, view_file, grep, etc.), safe idempotent reads are scaled
    // by `readonlyRepeatThreshold` and epoch-bounded: intervening mutating tool calls reset the
    // repetition counter because file/system state potentially changed.
    const currentEntry = normalized[normalized.length - 1];
    const currentFingerprint = currentEntry.fingerprint;
    const isReadOnly = isReadOnlyOrInspectionTool(currentEntry.toolName, currentEntry.args);
    const effectiveThreshold = isReadOnly ? this.readonlyRepeatThreshold : this.repeatThreshold;

    let count = 0;
    if (isReadOnly) {
      // Find the index of the most recent mutating action in the window, if any.
      let lastMutationIndex = -1;
      for (let i = normalized.length - 2; i >= 0; i--) {
        const entry = normalized[i];
        if (isMutatingTool(entry.toolName, entry.args)) {
          lastMutationIndex = i;
          break;
        }
      }

      // Count occurrences of currentFingerprint only within the current state epoch
      // (i.e. since the most recent state mutation).
      const startIndex = lastMutationIndex >= 0 ? lastMutationIndex + 1 : 0;
      for (let i = startIndex; i < normalized.length; i++) {
        if (normalized[i].fingerprint === currentFingerprint) {
          count += 1;
        }
      }
    } else {
      for (const item of normalized) {
        if (item.fingerprint === currentFingerprint) {
          count += 1;
        }
      }
    }

    if (count >= effectiveThreshold) {
      return { kind: "repeat", fingerprints: [currentFingerprint], count };
    }

    return null;
  }

  /**
   * Longest strictly-alternating suffix over exactly two distinct
   * fingerprints, if it carries at least `pingpongThreshold` transitions.
   */
  private detectPingpong(
    window: readonly WindowEntry[]
  ): { kind: "pingpong"; fingerprints: string[]; count: number } | null {
    if (window.length < this.pingpongThreshold + 1) return null;

    // Walk backwards while the run stays strictly alternating AND keeps
    // covering exactly two distinct fingerprints.
    const run: WindowEntry[] = [window[window.length - 1]];
    for (let i = window.length - 2; i >= 0; i--) {
      if (window[i].fingerprint === window[i + 1]?.fingerprint) break; // adjacent duplicates end the run
      run.push(window[i]);
      const distinct = new Set(run.map((e) => e.fingerprint));
      if (distinct.size > 2) break; // a third fingerprint ends the ping-pong
    }
    if (run.length < 2) return null;

    const distinct = Array.from(new Set(run.map((e) => e.fingerprint)));
    if (distinct.length !== 2) return null;

    const [fpA, fpB] = distinct;

    // Concurrency Guard: An alternating loop requires the conversation to transition between A and B.
    // If all calls to fpA came exclusively from one requestId, and all calls to fpB came exclusively
    // from a different concurrent requestId (disjoint sets), this is two independent parallel streams
    // interleaving their distinct tools, NOT a single conversation caught in an alternating loop.
    const reqsA = new Set(
      run.filter((e) => e.fingerprint === fpA && e.requestId).map((e) => e.requestId)
    );
    const reqsB = new Set(
      run.filter((e) => e.fingerprint === fpB && e.requestId).map((e) => e.requestId)
    );

    if (reqsA.size > 0 && reqsB.size > 0) {
      let sharesAnyRequest = false;
      for (const r of reqsA) {
        if (reqsB.has(r)) {
          sharesAnyRequest = true;
          break;
        }
      }
      if (!sharesAnyRequest && reqsA.size + reqsB.size >= 2) {
        return null;
      }
    }

    // `run.length - 1` transitions = cycles.
    const cycles = run.length - 1;
    if (cycles < this.pingpongThreshold) return null;

    return { kind: "pingpong", fingerprints: distinct, count: cycles };
  }

  /**
   * Observe one tool rejection for a session.
   *
   * Catches polymorphic repeat loops (e.g. repeated rejections of the same tool
   * despite varying arguments) and unknown-tool floods across the window.
   */
  observeRejection(
    sessionId: string,
    toolName: string,
    reason: string,
    requestId?: string
  ): LoopDetection | null {
    try {
      return this.observeRejectionInternal(sessionId, toolName, reason, requestId);
    } catch (err) {
      log.error("loop breaker observeRejection failed; passing through (fail-open)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private observeRejectionInternal(
    sessionId: string,
    toolName: string,
    reason: string,
    requestId?: string
  ): LoopDetection | null {
    if (!this.enabled || !sessionId || !toolName) return null;

    let state = this.sessions.get(sessionId);
    if (!state) {
      this.evictIfNeeded();
      state = { window: [], rejections: [], interventions: 0, lastActive: this.now() };
      this.sessions.set(sessionId, state);
    }
    state.lastActive = this.now();
    if (!state.rejections) state.rejections = [];

    state.rejections.push({ toolName, reason, at: this.now(), requestId });
    if (state.rejections.length > this.windowSize) {
      state.rejections.splice(0, state.rejections.length - this.windowSize);
    }

    // 1. Polymorphic Repeat: same toolName rejected >= repeatThreshold times in the window
    let sameToolCount = 0;
    for (const r of state.rejections) {
      if (r.toolName === toolName) {
        sameToolCount += 1;
      }
    }
    if (sameToolCount >= this.repeatThreshold) {
      state.interventions += 1;
      return {
        kind: "polymorphic_repeat",
        fingerprints: [toolName],
        count: sameToolCount,
        interventions: state.interventions,
        shouldAbort: state.interventions > this.maxInterventions,
      };
    }

    // 2. Unknown Tool Flood: unknown_tool reason >= repeatThreshold times in the window
    if (reason === "unknown_tool") {
      let unknownCount = 0;
      for (const r of state.rejections) {
        if (r.reason === "unknown_tool") {
          unknownCount += 1;
        }
      }
      if (unknownCount >= this.repeatThreshold) {
        state.interventions += 1;
        return {
          kind: "unknown_tool_loop",
          fingerprints: state.rejections
            .filter((r) => r.reason === "unknown_tool")
            .map((r) => r.toolName),
          count: unknownCount,
          interventions: state.interventions,
          shouldAbort: state.interventions > this.maxInterventions,
        };
      }
    }

    return null;
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
      state.rejections = [];
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
