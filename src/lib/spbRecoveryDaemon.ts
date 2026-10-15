/**
 * SPB-IR Autonomous Recovery & Monitoring Cron Daemon
 * Periodically evaluates system telemetry, circuit breakers, connection cooldowns,
 * and stale checkpoints, automatically executing self-healing recovery actions
 * (e.g. half-open circuit breaker probing, cooldown reset, and audit log pruning).
 *
 * Design decisions:
 *  - Circuit-breaker reads/writes go exclusively through domainState.ts (no raw SQL).
 *  - Connection-cooldown clearing goes through providers/rateLimit.ts (no raw SQL).
 *  - The daemon is lazy-instantiated so it does not initialise the DB at Next.js build time.
 *  - A bounded consecutive-error counter aborts the sweep loop after 5 unrecovered failures
 *    to prevent an infinite crash/retry spiral.
 */

import { isNextBuildPhase } from "@/lib/buildPhase";
import { getSpbTelemetrySummary, pruneStaleCheckpoints } from "@/lib/db/spbState";
import {
  loadAllCircuitBreakerStates,
  loadCircuitBreakerState,
  saveCircuitBreakerState,
} from "@/lib/db/domainState";
import { clearStaleCrashCooldowns } from "@/lib/db/providers/rateLimit";

const DEFAULT_RECOVERY_INTERVAL_MS = 60_000; // 1 minute sweep loop
const STALE_CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_CB_COOLDOWN_MS = 30_000; // fallback when options.cooldownMs is absent
const MAX_CONSECUTIVE_ERRORS = 5; // abort sweep loop after this many unrecovered failures

export interface SpbDaemonStatus {
  running: boolean;
  intervalMs: number;
  lastRunAt: number | null;
  totalSweeps: number;
  recoveredCount: number;
  lastError: string | null;
  consecutiveErrors: number;
}

class SpbRecoveryDaemon {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private intervalMs: number;
  private lastRunAt: number | null = null;
  private totalSweeps = 0;
  private recoveredCount = 0;
  private lastError: string | null = null;
  private consecutiveErrors = 0;

  constructor(intervalMs = DEFAULT_RECOVERY_INTERVAL_MS) {
    this.intervalMs = Math.max(30_000, intervalMs); // Minimum 30s
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(
      `[SPB Recovery Daemon] Starting autonomous monitoring & recovery daemon (interval: ${this.intervalMs}ms)`
    );

    this.timer = setInterval(() => {
      void this.executeSweep();
    }, this.intervalMs);

    // Unref so test/cli runner doesn't hang
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.running) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.log("[SPB Recovery Daemon] Stopped.");
  }

  async executeSweep(): Promise<void> {
    this.totalSweeps += 1;
    this.lastRunAt = Date.now();

    // Abort sweep when too many consecutive failures have occurred to avoid
    // an infinite crash/log-spam loop.
    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(
        `[SPB Recovery Daemon] Aborting sweep: ${this.consecutiveErrors} consecutive errors exceeded threshold (${MAX_CONSECUTIVE_ERRORS}). Stop and restart the daemon to resume.`
      );
      this.stop();
      return;
    }

    try {
      const now = Date.now();

      // 1. Prune stale SPB state checkpoints older than 24 hours.
      //    All operations route strictly through the spbState domain module — no raw SQL.
      const prunedCount = pruneStaleCheckpoints(STALE_CHECKPOINT_MAX_AGE_MS);
      if (prunedCount > 0) {
        console.log(`[SPB Recovery Daemon] Pruned ${prunedCount} stale SPB state checkpoints.`);
      }

      // 2. Evaluate Circuit Breakers for auto-recovery (OPEN → HALF_OPEN probe readiness).
      //    All reads/writes go through the domainState domain module — no raw SQL.
      const openBreakers = loadAllCircuitBreakerStates().filter((cb) => cb.state === "OPEN");

      for (const cb of openBreakers) {
        // Fetch the individual record to obtain the options blob (cooldownMs / circuitBreakerReset).
        const full = loadCircuitBreakerState(cb.name);
        if (!full) continue;

        const opts = full.options as Record<string, unknown> | null | undefined;
        const cooldownMs =
          typeof opts?.cooldownMs === "number" && opts.cooldownMs > 0
            ? opts.cooldownMs
            : typeof opts?.circuitBreakerReset === "number" && opts.circuitBreakerReset > 0
              ? (opts.circuitBreakerReset as number) * 1_000 // seconds → ms
              : DEFAULT_CB_COOLDOWN_MS;

        const lastFail = full.lastFailureTime ?? 0;
        if (now - lastFail > cooldownMs) {
          // Transition OPEN → HALF_OPEN for automated probe testing.
          // Preserve failure_count — a probe on the existing count lets the breaker
          // make an informed decision when the probe completes.
          saveCircuitBreakerState(cb.name, {
            ...full,
            state: "HALF_OPEN",
          });
          this.recoveredCount += 1;
          console.log(
            `[SPB Recovery Daemon] Transitioned circuit breaker '${cb.name}' from OPEN to HALF_OPEN (cooldown: ${cooldownMs}ms).`
          );
        }
      }

      // 3. Clear expired connection cooldowns (rateLimitedUntil in the past).
      //    Delegates entirely to the providers/rateLimit domain module; no raw SQL.
      const { cleared } = clearStaleCrashCooldowns();
      if (cleared > 0) {
        this.recoveredCount += cleared;
        console.log(
          `[SPB Recovery Daemon] Cleared expired cooldown for ${cleared} provider connection(s).`
        );
      }

      // 4. Log telemetry summary heartbeat every 15 sweeps.
      const telemetry = getSpbTelemetrySummary();
      if (telemetry.totalRoutes > 0 && this.totalSweeps % 15 === 0) {
        console.log(
          `[SPB Recovery Daemon Heartbeat] Total Routes: ${telemetry.totalRoutes}, Checkpoints Restored: ${telemetry.checkpointsRestored}, Fallbacks Triggered: ${telemetry.fallbacksTriggered}`
        );
      }

      this.lastError = null;
      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(
        `[SPB Recovery Daemon] Sweep execution error (consecutive: ${this.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`,
        this.lastError
      );
    }
  }

  getStatus(): SpbDaemonStatus {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      lastRunAt: this.lastRunAt,
      totalSweeps: this.totalSweeps,
      recoveredCount: this.recoveredCount,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
    };
  }
}

/**
 * Singleton lazy accessor.
 *
 * We do NOT instantiate the daemon at module-load time because `getDbInstance()`
 * is called transitively during the first sweep, and Next.js production builds
 * import every server module — instantiating SQLite in the build worker hangs
 * or crashes the build. The accessor pattern lets callers reference
 * `getSpbRecoveryDaemon()` without triggering DB initialisation until the
 * server is actually running.
 */
let _daemon: SpbRecoveryDaemon | null = null;

export function getSpbRecoveryDaemon(): SpbRecoveryDaemon {
  if (!_daemon) {
    _daemon = new SpbRecoveryDaemon();
  }
  return _daemon;
}

/**
 * Convenience singleton reference kept for backward-compatible call sites that
 * imported `spbRecoveryDaemon` directly. Only created when the module is loaded
 * outside a build phase; guarded so Next.js production builds are safe.
 *
 * New call sites should prefer `getSpbRecoveryDaemon()`.
 */
export const spbRecoveryDaemon: SpbRecoveryDaemon = isNextBuildPhase()
  ? // Return a no-op stub during builds; SpbRecoveryDaemon is not exported as a
    // type here so the cast is the only way to satisfy the const type without
    // duplicating the class interface.
    (new (class NullDaemon {
      start() {}
      stop() {}
      async executeSweep() {}
      getStatus(): SpbDaemonStatus {
        return {
          running: false,
          intervalMs: 0,
          lastRunAt: null,
          totalSweeps: 0,
          recoveredCount: 0,
          lastError: null,
          consecutiveErrors: 0,
        };
      }
    })() as unknown as SpbRecoveryDaemon)
  : getSpbRecoveryDaemon();
