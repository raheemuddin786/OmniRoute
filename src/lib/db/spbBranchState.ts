/**
 * SPB-IR Branch Checkpoint & State Management Domain Module
 * Manages persistence of branch checkpoints, continuation capsules,
 * and branch lifecycle in SQLite with transaction safety.
 */

import { getDbInstance } from "./core";

export interface SpbBranchCheckpoint {
  branchId: string;
  parentSessionId: string;
  anchorTurnHash: string;
  activeCapsule: string;
  mergedAt: number | null;
  createdAt: number;
}

let _branchTablesInitialized = false;

export function initSpbBranchTables(): void {
  if (_branchTablesInitialized) return;
  try {
    const db = getDbInstance();
    db.exec(`
      CREATE TABLE IF NOT EXISTS spb_branch_checkpoints (
        branch_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        anchor_turn_hash TEXT NOT NULL,
        active_capsule TEXT NOT NULL,
        merged_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spb_branch_parent ON spb_branch_checkpoints(parent_session_id);
      CREATE INDEX IF NOT EXISTS idx_spb_branch_anchor ON spb_branch_checkpoints(anchor_turn_hash);
    `);
    _branchTablesInitialized = true;
  } catch (err) {
    console.error("[SPB Branch State] Failed to initialize tables:", err);
  }
}

/** Test-only: reset the init guard so tables can be re-created after a DB reset. */
export function __resetSpbBranchInitForTests(): void {
  _branchTablesInitialized = false;
}

export function saveBranchCheckpoint(checkpoint: SpbBranchCheckpoint): boolean {
  try {
    initSpbBranchTables();
    const db = getDbInstance();
    db.prepare(
      `
      INSERT OR REPLACE INTO spb_branch_checkpoints
      (branch_id, parent_session_id, anchor_turn_hash, active_capsule, merged_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(
      checkpoint.branchId,
      checkpoint.parentSessionId,
      checkpoint.anchorTurnHash,
      checkpoint.activeCapsule,
      checkpoint.mergedAt,
      checkpoint.createdAt
    );
    return true;
  } catch (err) {
    console.error("[SPB Branch State] Failed to save branch checkpoint:", err);
    return false;
  }
}

export function getBranchCheckpoint(branchId: string): SpbBranchCheckpoint | null {
  try {
    initSpbBranchTables();
    const db = getDbInstance();
    const row = db
      .prepare(
        `SELECT branch_id, parent_session_id, anchor_turn_hash, active_capsule, merged_at, created_at
         FROM spb_branch_checkpoints WHERE branch_id = ?`
      )
      .get(branchId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      branchId: String(row.branch_id),
      parentSessionId: String(row.parent_session_id),
      anchorTurnHash: String(row.anchor_turn_hash),
      activeCapsule: String(row.active_capsule),
      mergedAt: row.merged_at != null ? Number(row.merged_at) : null,
      createdAt: Number(row.created_at),
    };
  } catch (err) {
    console.error("[SPB Branch State] Failed to get branch checkpoint:", err);
    return null;
  }
}

export function listBranchCheckpoints(parentSessionId: string): SpbBranchCheckpoint[] {
  try {
    initSpbBranchTables();
    const db = getDbInstance();
    const rows = db
      .prepare(
        `SELECT branch_id, parent_session_id, anchor_turn_hash, active_capsule, merged_at, created_at
         FROM spb_branch_checkpoints WHERE parent_session_id = ? ORDER BY created_at ASC`
      )
      .all(parentSessionId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      branchId: String(row.branch_id),
      parentSessionId: String(row.parent_session_id),
      anchorTurnHash: String(row.anchor_turn_hash),
      activeCapsule: String(row.active_capsule),
      mergedAt: row.merged_at != null ? Number(row.merged_at) : null,
      createdAt: Number(row.created_at),
    }));
  } catch (err) {
    console.error("[SPB Branch State] Failed to list branch checkpoints:", err);
    return [];
  }
}

export function markBranchMerged(branchId: string, mergedAt = Date.now()): boolean {
  try {
    initSpbBranchTables();
    const db = getDbInstance();
    const result = db
      .prepare(`UPDATE spb_branch_checkpoints SET merged_at = ? WHERE branch_id = ?`)
      .run(mergedAt, branchId);
    return result.changes > 0;
  } catch (err) {
    console.error("[SPB Branch State] Failed to mark branch merged:", err);
    return false;
  }
}

export function deleteBranchCheckpoint(branchId: string): boolean {
  try {
    initSpbBranchTables();
    const db = getDbInstance();
    const result = db
      .prepare(`DELETE FROM spb_branch_checkpoints WHERE branch_id = ?`)
      .run(branchId);
    return result.changes > 0;
  } catch (err) {
    console.error("[SPB Branch State] Failed to delete branch checkpoint:", err);
    return false;
  }
}
