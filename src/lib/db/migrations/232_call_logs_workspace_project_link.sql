-- 219_call_logs_workspace_project_link.sql
-- Adds workspace_root and project_id columns to call_logs so proxy requests can be
-- associated with their originating workspace/project. This enables per-project
-- token economics, session aggregation, and model distribution in the analytics dashboard.

ALTER TABLE call_logs ADD COLUMN workspace_root TEXT DEFAULT NULL;
ALTER TABLE call_logs ADD COLUMN project_id TEXT DEFAULT NULL;

-- Index for fast per-project analytics queries
CREATE INDEX IF NOT EXISTS idx_call_logs_workspace_root ON call_logs(workspace_root);
CREATE INDEX IF NOT EXISTS idx_call_logs_project_id ON call_logs(project_id);