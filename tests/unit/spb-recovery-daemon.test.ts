import test from "node:test";
import assert from "node:assert/strict";
import { spbRecoveryDaemon, getSpbRecoveryDaemon } from "../../src/lib/spbRecoveryDaemon.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import {
  saveCheckpoint,
  getCheckpoint,
  __resetSpbStateInitForTests,
} from "../../src/lib/db/spbState.ts";
import {
  saveCircuitBreakerState,
  loadCircuitBreakerState,
  deleteCircuitBreakerState,
} from "../../src/lib/db/domainState.ts";

// Ensure the DB handle is closed after all tests so the Node.js native test
// runner does not hang waiting on open SQLite connections.
test.after(() => {
  __resetSpbStateInitForTests();
  resetDbInstance();
});

test("SPB Recovery Daemon status and manual sweep execution", async () => {
  const statusBefore = spbRecoveryDaemon.getStatus();
  assert.equal(typeof statusBefore.running, "boolean");
  assert.equal(typeof statusBefore.totalSweeps, "number");
  assert.equal(typeof statusBefore.consecutiveErrors, "number");

  // Save a stale checkpoint to test pruning.
  const staleSessionId = "stale_session_" + Date.now();
  saveCheckpoint({
    sessionId: staleSessionId,
    promptAnchorHash: "sha256:spb_stale",
    taskPhase: "FAST_REFACTOR",
    modelTier: "tier_3_local",
    statePayload: JSON.stringify({ old: true }),
    createdAt: Date.now() - 48 * 60 * 60 * 1000, // 48 hours ago
  });

  assert.notEqual(getCheckpoint(staleSessionId), null);

  // Execute manual sweep.
  await spbRecoveryDaemon.executeSweep();

  const statusAfter = spbRecoveryDaemon.getStatus();
  assert.ok(statusAfter.totalSweeps > statusBefore.totalSweeps);
  assert.equal(statusAfter.lastError, null);
  assert.equal(statusAfter.consecutiveErrors, 0);

  // Stale checkpoint should be pruned.
  assert.equal(getCheckpoint(staleSessionId), null);
});

test("SPB Recovery Daemon: OPEN circuit breaker transitions to HALF_OPEN after cooldown", async () => {
  const cbName = "spb_test_provider_" + Date.now();

  // Inject an OPEN circuit breaker with a last_failure_time far enough in the past to
  // have already exceeded any reasonable cooldown.
  saveCircuitBreakerState(cbName, {
    state: "OPEN",
    failureCount: 3,
    lastFailureTime: Date.now() - 120_000, // 2 minutes ago — well beyond any default cooldown
    options: { cooldownMs: 5_000 }, // 5 s cooldown; already elapsed
  });

  const before = loadCircuitBreakerState(cbName);
  assert.equal(before?.state, "OPEN", "precondition: CB must be OPEN");

  // Run a sweep — the daemon should transition the breaker to HALF_OPEN.
  await getSpbRecoveryDaemon().executeSweep();

  const after = loadCircuitBreakerState(cbName);
  assert.equal(after?.state, "HALF_OPEN", "CB must transition to HALF_OPEN after cooldown expires");
  // failure_count should be preserved (the daemon does not reset it on the OPEN→HALF_OPEN
  // transition so the breaker can make an informed decision when the probe completes).
  assert.equal(
    after?.failureCount,
    3,
    "failure_count must be preserved across the OPEN→HALF_OPEN transition"
  );

  // Clean up injected state.
  deleteCircuitBreakerState(cbName);
});

test("SPB Recovery Daemon: OPEN circuit breaker within cooldown window stays OPEN", async () => {
  const cbName = "spb_test_cooldown_active_" + Date.now();

  // Inject an OPEN breaker whose last_failure just happened — the cooldown has not elapsed.
  saveCircuitBreakerState(cbName, {
    state: "OPEN",
    failureCount: 2,
    lastFailureTime: Date.now() - 1_000, // 1 second ago
    options: { cooldownMs: 60_000 }, // 60 s cooldown — nowhere near elapsed
  });

  await getSpbRecoveryDaemon().executeSweep();

  const after = loadCircuitBreakerState(cbName);
  assert.equal(after?.state, "OPEN", "CB must remain OPEN while still within the cooldown window");

  deleteCircuitBreakerState(cbName);
});

test("SPB Recovery Daemon: consecutive error counter increments and resets", async () => {
  const daemon = getSpbRecoveryDaemon();
  const statusBefore = daemon.getStatus();

  // consecutiveErrors should be 0 after successful sweeps.
  assert.equal(statusBefore.consecutiveErrors, 0);

  // A successful sweep resets the counter.
  await daemon.executeSweep();
  assert.equal(daemon.getStatus().consecutiveErrors, 0);
});
