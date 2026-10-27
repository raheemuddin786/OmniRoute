-- SPDX-License-Identifier: MIT
-- SPDX-FileCopyrightText: 2026 OmniRoute

-- Migration 215: Add guidance_contract column to spb_state_checkpoints for hierarchical supervision
ALTER TABLE spb_state_checkpoints ADD COLUMN guidance_contract TEXT;
