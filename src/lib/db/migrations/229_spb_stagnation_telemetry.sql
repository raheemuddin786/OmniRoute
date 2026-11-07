-- SPDX-License-Identifier: MIT
-- SPDX-FileCopyrightText: 2026 OmniRoute

-- Migration 216: Add stagnation tracking and auto-recovery telemetry to SPB state checkpoints and audit
ALTER TABLE spb_state_checkpoints ADD COLUMN consecutive_reads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spb_state_checkpoints ADD COLUMN stagnation_recovered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spb_telemetry_audit ADD COLUMN stagnation_detected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spb_telemetry_audit ADD COLUMN stagnation_recovered INTEGER NOT NULL DEFAULT 0;
