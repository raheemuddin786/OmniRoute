-- SPDX-License-Identifier: MIT
-- SPDX-FileCopyrightText: 2026 OmniRoute

-- Migration 220: project_registry provenance + status columns
--
-- The original migration 217 declared `provenance TEXT DEFAULT 'derived'` and
-- `status TEXT DEFAULT 'active'` in the CREATE TABLE, but the production
-- database was created from a pre-217 schema snapshot that lacked both
-- columns (the live DB's `CREATE TABLE project_registry` has neither). As a
-- result every read of a project row crashed with "no such column: provenance",
-- which silently swallowed the auto-registration attempt in
-- `saveCallLog` (best-effort try/catch) and left 865 call_logs rows with
-- workspace_root set but project_id NULL — i.e. the new workspace was
-- discovered but never registered, so it never appeared in the usage
-- analytics Projects & Workspaces view.
--
-- This migration is idempotent: it only ADDS the columns when they are
-- missing, and never drops or renames existing columns.

ALTER TABLE project_registry ADD COLUMN provenance TEXT DEFAULT 'derived';
ALTER TABLE project_registry ADD COLUMN status TEXT DEFAULT 'active';

-- Backfill any rows created before this migration so reads never see NULL.
UPDATE project_registry SET provenance = 'derived' WHERE provenance IS NULL OR provenance = '';
UPDATE project_registry SET status = 'active' WHERE status IS NULL OR status = '';