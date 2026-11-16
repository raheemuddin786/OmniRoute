-- SPDX-License-Identifier: MIT
-- SPDX-FileCopyrightText: 2026 OmniRoute

-- Migration 240: Add open_items_count and open_items_summary to spb_telemetry_audit
ALTER TABLE spb_telemetry_audit ADD COLUMN open_items_count INTEGER DEFAULT 0;
ALTER TABLE spb_telemetry_audit ADD COLUMN open_items_summary TEXT;
