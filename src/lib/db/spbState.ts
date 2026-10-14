/**
 * SPB-IR State Checkpointing & Prompt Anchor Domain Module
 * Manages atomic persistence of session checkpoints and prompt anchor hashes in SQLite.
 */

import { getDbInstance } from "./core.ts";

export interface SpbStateCheckpoint {
  sessionId: string;
  promptAnchorHash: string;
  taskPhase: string;
  modelTier: string;
  statePayload: string;
  createdAt: number;
}

export function initSpbStateTable(): void {
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
  `);
}

export function saveCheckpoint(checkpoint: SpbStateCheckpoint): void {
  initSpbStateTable();
  const db = getDbInstance();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO spb_state_checkpoints
    (session_id, prompt_anchor_hash, task_phase, model_tier, state_payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    checkpoint.sessionId,
    checkpoint.promptAnchorHash,
    checkpoint.taskPhase,
    checkpoint.modelTier,
    checkpoint.statePayload,
    checkpoint.createdAt
  );
}

export function getCheckpoint(sessionId: string): SpbStateCheckpoint | null {
  initSpbStateTable();
  const db = getDbInstance();
  const stmt = db.prepare(`
    SELECT session_id, prompt_anchor_hash, task_phase, model_tier, state_payload, created_at
    FROM spb_state_checkpoints WHERE session_id = ?
  `);
  const row = stmt.get(sessionId) as
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
}
