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
  guidanceContract?: unknown;
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

export interface LearnedOptimization {
  id?: number;
  patternHash: string;
  tier: string;
  taskPhase: string;
  optimizationStrategy: string;
  enhancementTemplate: string;
  successCount: number;
  failureCount: number;
  avgSatisfactionScore: number;
  createdAt: number;
  updatedAt: number;
}

export interface IntentEvaluationRecord {
  id?: number;
  sessionId: string;
  promptAnchorHash: string;
  tier: string;
  taskPhase: string;
  satisfactionScore: number;
  detectedOmissions: string;
  repromptCount: number;
  repromptSuccess: boolean;
  evaluatedAt: number;
}

export interface ConfirmationGateRecord {
  id?: number;
  sessionId: string;
  promptHash: string;
  reason: string;
  suggestedAction: string;
  status: "PENDING" | "CONFIRMED" | "BYPASSED" | "REJECTED";
  createdAt: number;
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
        guidance_contract TEXT,
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

      CREATE TABLE IF NOT EXISTS spb_learned_optimizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_hash TEXT NOT NULL UNIQUE,
        tier TEXT NOT NULL,
        task_phase TEXT NOT NULL,
        optimization_strategy TEXT NOT NULL,
        enhancement_template TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 1,
        failure_count INTEGER NOT NULL DEFAULT 0,
        avg_satisfaction_score REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spb_opt_pattern ON spb_learned_optimizations(pattern_hash);
      CREATE INDEX IF NOT EXISTS idx_spb_opt_tier ON spb_learned_optimizations(tier);

      CREATE TABLE IF NOT EXISTS spb_intent_evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        prompt_anchor_hash TEXT NOT NULL,
        tier TEXT NOT NULL,
        task_phase TEXT NOT NULL,
        satisfaction_score REAL NOT NULL,
        detected_omissions TEXT NOT NULL,
        reprompt_count INTEGER NOT NULL DEFAULT 0,
        reprompt_success INTEGER NOT NULL DEFAULT 1,
        evaluated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spb_eval_session ON spb_intent_evaluations(session_id);
      CREATE INDEX IF NOT EXISTS idx_spb_eval_hash ON spb_intent_evaluations(prompt_anchor_hash);

      CREATE TABLE IF NOT EXISTS spb_confirmation_gates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        suggested_action TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spb_gate_session ON spb_confirmation_gates(session_id);
    `);

    // Ensure guidance_contract column exists for backward-compatible upgrades
    try {
      db.exec("ALTER TABLE spb_state_checkpoints ADD COLUMN guidance_contract TEXT;");
    } catch {
      // Column already exists or table newly created with it
    }

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
    const guidanceContractStr = checkpoint.guidanceContract
      ? JSON.stringify(checkpoint.guidanceContract)
      : null;
    db.prepare(
      `
      INSERT OR REPLACE INTO spb_state_checkpoints
      (session_id, prompt_anchor_hash, task_phase, model_tier, state_payload, guidance_contract, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      checkpoint.sessionId,
      checkpoint.promptAnchorHash,
      checkpoint.taskPhase,
      checkpoint.modelTier,
      checkpoint.statePayload,
      guidanceContractStr,
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
      SELECT session_id, prompt_anchor_hash, task_phase, model_tier, state_payload, guidance_contract, created_at
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
          guidance_contract?: string | null;
          created_at: number;
        }
      | undefined;

    if (!row) return null;

    let parsedGuidance: unknown = undefined;
    if (row.guidance_contract) {
      try {
        parsedGuidance = JSON.parse(row.guidance_contract);
      } catch {
        parsedGuidance = undefined;
      }
    }

    return {
      sessionId: row.session_id,
      promptAnchorHash: row.prompt_anchor_hash,
      taskPhase: row.task_phase,
      modelTier: row.model_tier,
      statePayload: row.state_payload,
      guidanceContract: parsedGuidance,
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

export function saveLearnedOptimization(opt: Omit<LearnedOptimization, "id">): boolean {
  try {
    initSpbStateTable();
    const db = getDbInstance();
    db.prepare(
      `
      INSERT INTO spb_learned_optimizations
      (pattern_hash, tier, task_phase, optimization_strategy, enhancement_template, success_count, failure_count, avg_satisfaction_score, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pattern_hash) DO UPDATE SET
        success_count = success_count + excluded.success_count,
        failure_count = failure_count + excluded.failure_count,
        avg_satisfaction_score = (avg_satisfaction_score * success_count + excluded.avg_satisfaction_score) / (success_count + 1),
        updated_at = excluded.updated_at
    `
    ).run(
      opt.patternHash,
      opt.tier,
      opt.taskPhase,
      opt.optimizationStrategy,
      opt.enhancementTemplate,
      opt.successCount ?? 1,
      opt.failureCount ?? 0,
      opt.avgSatisfactionScore ?? 1.0,
      opt.createdAt ?? Date.now(),
      opt.updatedAt ?? Date.now()
    );
    return true;
  } catch (err) {
    console.error("[SPB State] Failed to save learned optimization:", err);
    return false;
  }
}

export function getLearnedOptimization(patternHash: string): LearnedOptimization | null {
  try {
    initSpbStateTable();
    const db = getDbInstance();
    const row = db
      .prepare(`SELECT * FROM spb_learned_optimizations WHERE pattern_hash = ?`)
      .get(patternHash) as any;
    if (!row) return null;
    return {
      id: row.id,
      patternHash: row.pattern_hash,
      tier: row.tier,
      taskPhase: row.task_phase,
      optimizationStrategy: row.optimization_strategy,
      enhancementTemplate: row.enhancement_template,
      successCount: row.success_count,
      failureCount: row.failure_count,
      avgSatisfactionScore: row.avg_satisfaction_score,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (err) {
    console.error("[SPB State] Failed to get learned optimization:", err);
    return null;
  }
}

export function recordIntentEvaluation(evalRecord: Omit<IntentEvaluationRecord, "id">): boolean {
  try {
    initSpbStateTable();
    const db = getDbInstance();
    db.prepare(
      `
      INSERT INTO spb_intent_evaluations
      (session_id, prompt_anchor_hash, tier, task_phase, satisfaction_score, detected_omissions, reprompt_count, reprompt_success, evaluated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      evalRecord.sessionId,
      evalRecord.promptAnchorHash,
      evalRecord.tier,
      evalRecord.taskPhase,
      evalRecord.satisfactionScore,
      evalRecord.detectedOmissions,
      evalRecord.repromptCount,
      evalRecord.repromptSuccess ? 1 : 0,
      evalRecord.evaluatedAt ?? Date.now()
    );
    return true;
  } catch (err) {
    console.error("[SPB State] Failed to record intent evaluation:", err);
    return false;
  }
}

export function recordConfirmationGate(gate: Omit<ConfirmationGateRecord, "id">): boolean {
  try {
    initSpbStateTable();
    const db = getDbInstance();
    db.prepare(
      `
      INSERT INTO spb_confirmation_gates
      (session_id, prompt_hash, reason, suggested_action, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(
      gate.sessionId,
      gate.promptHash,
      gate.reason,
      gate.suggestedAction,
      gate.status,
      gate.createdAt ?? Date.now()
    );
    return true;
  } catch (err) {
    console.error("[SPB State] Failed to record confirmation gate:", err);
    return false;
  }
}
