import test from "node:test";
import assert from "node:assert/strict";
import {
  initSpbStateTable,
  recordSpbTelemetry,
  getSpbActivityRecords,
  getSpbDetailedMetrics,
} from "../../src/lib/db/spbState";
import { resetDbInstance } from "../../src/lib/db/core";

test.beforeEach(() => {
  resetDbInstance();
  initSpbStateTable();
});

test.afterEach(() => {
  resetDbInstance();
});

test("SPB Activity & Metrics DB: records telemetry and queries with time/tier filters", () => {
  const now = Date.now();
  const testSessionId = `test_sess_${now}`;

  // 1. Record sample telemetry items
  recordSpbTelemetry({
    sessionId: testSessionId,
    taskPhase: "ARCHITECTURAL_PLANNING",
    modelTier: "tier_1_apex",
    checkpointRestored: false,
    fallbackTriggered: false,
    statusCode: 200,
    latencyMs: 15,
    timestamp: now - 1000,
  });

  recordSpbTelemetry({
    sessionId: testSessionId,
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    checkpointRestored: true,
    fallbackTriggered: false,
    statusCode: 200,
    latencyMs: 25,
    timestamp: now - 500,
    stagnationDetected: true,
    stagnationRecovered: true,
  });

  recordSpbTelemetry({
    sessionId: testSessionId,
    taskPhase: "INSPECTION_SYNTHESIS",
    modelTier: "tier_3_local",
    checkpointRestored: false,
    fallbackTriggered: false,
    statusCode: 200,
    latencyMs: 8,
    timestamp: now,
  });

  // 2. Query activity records for this session
  const activityResult = getSpbActivityRecords({
    sessionId: testSessionId,
    limit: 10,
  });

  assert.equal(activityResult.total, 3, "Should return 3 total records for session");
  assert.equal(activityResult.records.length, 3, "Records array length should be 3");

  // Records should be ordered timestamp DESC
  assert.equal(activityResult.records[0].modelTier, "tier_3_local");
  assert.equal(activityResult.records[1].modelTier, "tier_2_resilient");
  assert.equal(activityResult.records[1].stagnationRecovered, true);
  assert.equal(activityResult.records[2].modelTier, "tier_1_apex");

  // 3. Query filtered by tier
  const tier1Only = getSpbActivityRecords({
    sessionId: testSessionId,
    tier: "tier_1_apex",
  });
  assert.equal(tier1Only.total, 1);
  assert.equal(tier1Only.records[0].taskPhase, "ARCHITECTURAL_PLANNING");

  // 4. Query detailed metrics
  const metrics = getSpbDetailedMetrics({
    sessionId: testSessionId,
    timeRange: "1h",
  });

  assert.equal(metrics.totalRoutes, 3);
  assert.equal(metrics.tierDistribution["tier_1_apex"], 1);
  assert.equal(metrics.tierDistribution["tier_2_resilient"], 1);
  assert.equal(metrics.tierDistribution["tier_3_local"], 1);
  assert.equal(metrics.stagnationRecoveredCount, 1);
  assert.equal(metrics.checkpointsRestoredCount, 1);
  assert.ok(metrics.avgLatencyMs > 0);
});

test("SPB Activity API Route: handles GET requests and parses filter parameters", async () => {
  const { GET } = await import("../../src/app/api/spb/activity/route");

  // Call route handler as in-process trusted caller (request = null / test context)
  const req = new Request("http://localhost:20128/api/spb/activity?limit=5&timeRange=24h");
  const res = await GET(req);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.records));
  assert.equal(typeof data.total, "number");
  assert.ok(data.metrics);
  assert.equal(typeof data.metrics.totalRoutes, "number");
});
