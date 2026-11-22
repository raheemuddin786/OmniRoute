-- SPDX-License-Identifier: MIT
-- SPDX-FileCopyrightText: 2026 OmniRoute

-- SPB-IR Zero-Intention-Loss Intelligence Layer Schema

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
  status TEXT NOT NULL, -- 'PENDING', 'CONFIRMED', 'BYPASSED', 'REJECTED'
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spb_gate_session ON spb_confirmation_gates(session_id);
