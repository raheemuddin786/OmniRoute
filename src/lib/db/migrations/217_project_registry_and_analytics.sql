-- SPDX-License-Identifier: MIT
-- SPDX-FileCopyrightText: 2026 OmniRoute

-- Migration 217: Project registry and on-demand analytics caching table
CREATE TABLE IF NOT EXISTS project_registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_path TEXT NOT NULL UNIQUE,
  description TEXT,
  tech_stack TEXT DEFAULT '[]',
  cloud_stack TEXT DEFAULT '[]',
  features TEXT DEFAULT '[]',
  files_count INTEGER DEFAULT 0,
  docs_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  memory_locations TEXT DEFAULT '[]',
  rag_status TEXT DEFAULT 'idle',
  rag_indexed_count INTEGER DEFAULT 0,
  analytics_cache TEXT,
  analytics_cached_at INTEGER,
  brief_cache TEXT,
  brief_generated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_registry_path ON project_registry(base_path);
CREATE INDEX IF NOT EXISTS idx_project_registry_status ON project_registry(status);
