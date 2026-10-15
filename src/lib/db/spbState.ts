/**
 * SPB-IR State Checkpointing & Prompt Anchor Domain Module (Production Hardened)
 * Manages atomic persistence of session checkpoints, prompt anchor hashes,
 * and routing telemetry metrics in SQLite with transaction safety and crash resilience.
 */

import { getDbInstance } from "./core";

export interface SpbStateCheckpoint {
  sessionId: string;
  promptAnchorHash: string;
  taskPhase: string;
  modelTier: string;
  statePayload: string;
  createdAt: number;
}

export interface SpbTelemetryRecord {
  sessionId: string;
  taskPhase: string;
  modelTier: string;
  checkpointRestored: boolean;
  fallbackTriggered: boolean;
  statusCode: number;
  latencyMs: number;
  timestamp: number;
}

export interface SpbTelemetrySummary {
  totalRoutes: number;
  checkpointsRestored: number;
  fallbacksTriggered: number;
  phaseDistribution: Record<string, number>;
  tierDistribution: Record<string, number>;
  lastRoutedAt: string | null;
}

// Lazy init guard — tables are created at most once per process lifetime.
let _tablesInitialized = false;

export function initSpbStateTable(): void {
  if (_tablesInitialized) return;
  try {
    const db = getDbInstance();
    db.exec(`
      CREATE TABLE IF NOT EXISTS spb_state_checkpoints (
        session_id TEXT PRIMARY KEY,
        prompt_anchor_hash TEXT NOT NULL,
        task_phase TEXT NOT NULL,
        model_tier TEXT NOT NULL,
        state_payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spb_anchor ON spb_state_checkpoints(prompt_anchor_hash);

      CREATE TABLE IF NOT EXISTS spb_telemetry_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        task_phase TEXT NOT NULL,
        model_tier TEXT NOT NULL,
        checkpoint_restored INTEGER NOT NULL,
        fallback_triggered INTEGER NOT NULL,
        status_code INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spb_telemetry_time ON spb_telemetry_audit(timestamp);
    `);
    _tablesInitialized = true;
  } catch (err) {
    console.error("[SPB State] Failed to initialize tables:", err);
  }
}

/** Test-only: reset the init guard so tables can be re-created after a DB reset. */
export function __resetSpbStateInitForTests(): void {
  _tablesInitialized = false;
}

export function saveCheckpoint(checkpoint: SpbStateCheckpoint): boolean {
  try {
    initSpbStateTable();
    const db = getDbInstance();
    db.prepare(
      `
      INSERT OR REPLACE INTO spb_state_checkpoints
      (session_id, prompt_anchor_hash, task_phase, model_tier, state_payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(
      checkpoint.sessionId,
      checkpoint.promptAnchorHash,
      checkpoint.taskPhase,
      checkpoint.modelTier,
      checkpoint.statePayload,
      checkpoint.createdAt
    );
    return true;
  } catch (err) {
    console.error("[SPB State] Failed to save checkpoint:", err);
    return false;
  }
}

export function getCheckpoint(sessionId: string): SpbStateCheckpoint | null {
  try {
    initSpbStateTable();
    const db = getDbInstance();
    const row = db
      .prepare(
        `
      SELECT session_id, prompt_anchor_hash, task_phase, model_tier, state_payload, created_at
      FROM spb_state_checkpoints WHERE session_id = ?
    `
      )
      .get(sessionId) as
      | {
          session_id: string;
          prompt_anchor_hash: string;
          task_phase: string;
          model_tier: string;
          state_payload: string;
          created_at: number;
        }
      | undefined;

    if (!row) return null;

    return {
      sessionId: row.session_id,
      promptAnchorHash: row.prompt_anchor_hash,
      taskPhase: row.task_phase,
      modelTier: row.model_tier,
      statePayload: row.state_payload,
      createdAt: row.created_at,
    };
  } catch (err) {
    console.error("[SPB State] Failed to get checkpoint:", err);
    return null;
  }
}

export function pruneStaleCheckpoints(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  try {
    initSpbStateTable();
    const db = getDbInstance();
    const pruneThreshold = Date.now() - maxAgeMs;
    const result = db
      .prepare(`DELETE FROM spb_state_checkpoints WHERE created_at < ?`)
      .run(pruneThreshold);
    return result.changes;
  } catch (err) {
    console.error("[SPB State] Failed to prune stale checkpoints:", err);
    return 0;
  }
}

export function recordSpbTelemetry(record: SpbTelemetryRecord): void {
  try {
    initSpbStateTable();
    const db = getDbInstance();
    db.prepare(
      `
      INSERT INTO spb_telemetry_audit
      (session_id, task_phase, model_tier, checkpoint_restored, fallback_triggered, status_code, latency_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      record.sessionId,
      record.taskPhase,
      record.modelTier,
      record.checkpointRestored ? 1 : 0,
      record.fallbackTriggered ? 1 : 0,
      record.statusCode,
      record.latencyMs,
      record.timestamp
    );
  } catch (err) {
    console.error("[SPB State] Failed to record telemetry:", err);
  }
}

export function getSpbTelemetrySummary(): SpbTelemetrySummary {
  const defaultSummary: SpbTelemetrySummary = {
    totalRoutes: 0,
    checkpointsRestored: 0,
    fallbacksTriggered: 0,
    phaseDistribution: {},
    tierDistribution: {},
    lastRoutedAt: null,
  };

  try {
    initSpbStateTable();
    const db = getDbInstance();

    // Consolidate scalar aggregates into a single query to avoid multiple round-trips.
    const summaryRow = db
      .prepare(
        `SELECT
           COUNT(*) AS total_routes,
           MAX(timestamp) AS max_time,
           SUM(checkpoint_restored) AS checkpoints_restored,
           SUM(fallback_triggered) AS fallbacks_triggered
         FROM spb_telemetry_audit`
      )
      .get() as
      | {
          total_routes: number;
          max_time: number | null;
          checkpoints_restored: number;
          fallbacks_triggered: number;
        }
      | undefined;

    if (!summaryRow || summaryRow.total_routes === 0) return defaultSummary;

    const phaseRows = db
      .prepare(`SELECT task_phase, COUNT(*) AS count FROM spb_telemetry_audit GROUP BY task_phase`)
      .all() as Array<{ task_phase: string; count: number }>;

    const tierRows = db
      .prepare(`SELECT model_tier, COUNT(*) AS count FROM spb_telemetry_audit GROUP BY model_tier`)
      .all() as Array<{ model_tier: string; count: number }>;

    const phaseDistribution: Record<string, number> = {};
    for (const r of phaseRows) phaseDistribution[r.task_phase] = r.count;

    const tierDistribution: Record<string, number> = {};
    for (const r of tierRows) tierDistribution[r.model_tier] = r.count;

    return {
      totalRoutes: summaryRow.total_routes,
      checkpointsRestored: summaryRow.checkpoints_restored || 0,
      fallbacksTriggered: summaryRow.fallbacks_triggered || 0,
      phaseDistribution,
      tierDistribution,
      lastRoutedAt: summaryRow.max_time ? new Date(summaryRow.max_time).toISOString() : null,
    };
  } catch (err) {
    console.error("[SPB State] Failed to build telemetry summary:", err);
    return defaultSummary;
  }
}
