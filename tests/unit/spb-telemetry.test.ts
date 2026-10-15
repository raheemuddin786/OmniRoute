import test from "node:test";
import assert from "node:assert/strict";
import { getSpbTelemetrySummary } from "../../../src/lib/db/spbState.ts";
import { resetDbInstance } from "../../../src/lib/db/core.ts";

// Close DB handle after all tests
test.after(() => {
  resetDbInstance();
});

test("SPB Telemetry Summary aggregates correctly", async () => {
  // Seed test data by inserting directly to DB
  const db = require('../../../src/lib/db/core.ts').getDbInstance();

  // Insert telemetry records
  const sessionId = "test_session_" + Date.now();
  const insertSql = `INSERT INTO spb_telemetry_audit (session_id, task_phase, model_tier, checkpoint_restored, fallback_triggered, status_code, latency_ms, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

  await db.prepare(insertSql).run(
    sessionId,
    "CODE_GENERATION",
    "tier_2_resilient",
    1,
    0,
    200,
    150,
    Date.now()
  );

  await db.prepare(insertSql).run(
    sessionId,
    "ARCHITECTURAL_PLANNING",
    "tier_1_apex",
    0,
    1,
    503,
    35,
    Date.now()
  );

  const summary = getSpbTelemetrySummary();
  assert.equal(summary.totalRoutes, 2);
  assert.equal(summary.checkpointsRestored, 1);
  assert.equal(summary.fallbacksTriggered, 1);
  assert.deepStrictEqual(Object.keys(summary.phaseDistribution), ["CODE_GENERATION", "ARCHITECTURAL_PLANNING"]);
  assert.equal(summary.phaseDistribution.CODE_GENERATION, 1);
  assert.equal(summary.phaseDistribution.ARCHITECTURAL_PLANNING, 1);
  assert.deepStrictEqual(Object.keys(summary.tierDistribution), ["tier_2_resilient", "tier_1_apex"]);
  assert.equal(summary.tierDistribution.tier_2_resilient, 1);
  assert.equal(summary.tierDistribution.tier_1_apex, 1);
});

test("SPB Telemetry Summary handles empty DB", () => {
  const summary = getSpbTelemetrySummary();
  assert.equal(summary.totalRoutes, 0);
  assert.equal(summary.checkpointsRestored, 0);
  assert.equal(summary.fallbacksTriggered, 0);
  assert.deepStrictEqual(summary.phaseDistribution, {});
  assert.deepStrictEqual(summary.tierDistribution, {});
  assert.equal(summary.lastRoutedAt, null);
});
