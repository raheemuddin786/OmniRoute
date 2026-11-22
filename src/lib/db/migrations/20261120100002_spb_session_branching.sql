-- SPDX-License-Identifier: MIT
-- SPDX-FileCopyrightText: 2026 OmniRoute

-- Migration 213: SPB session branching & continuation lineage
-- Adds parent lineage and continuation capsule tracking to agentic_conversations
ALTER TABLE agentic_conversations ADD COLUMN parent_conversation_id TEXT REFERENCES agentic_conversations(id);
ALTER TABLE agentic_conversations ADD COLUMN fork_turn_hash TEXT;
ALTER TABLE agentic_conversations ADD COLUMN branch_type TEXT DEFAULT 'trunk';
ALTER TABLE agentic_conversations ADD COLUMN continuation_capsule TEXT;

CREATE INDEX IF NOT EXISTS idx_agentic_parent ON agentic_conversations(parent_conversation_id);
CREATE INDEX IF NOT EXISTS idx_agentic_fork ON agentic_conversations(fork_turn_hash);

-- Branch checkpoints table for SPB
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
