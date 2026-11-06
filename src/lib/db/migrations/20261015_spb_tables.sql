-- SPDX-License-Identifier: MIT
-- SPDX-FileCopyrightText: 2026 OmniRoute

-- Create SPB-IR state checkpointing and telemetry tables
CREATE TABLE IF NOT EXISTS spb_state_checkpoints (
  session_id TEXT PRIMARY KEY,
  prompt_anchor_hash TEXT NOT NULL,
  task_phase TEXT NOT NULL,
  model_tier TEXT NOT NULL,
  state_payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spb_anchor ON spb_state_checkpoints(prompt_anchor_hash);

-- Create SPB-IR telemetry audit table
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

-- Insert initial tier_config if not exists
INSERT INTO tier_config (key, value, updated_at)
SELECT 'tier_config', '{"providerOverrides":[],"tierConfig":null}', datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM tier_config WHERE key = 'tier_config');