-- Migration 218: Project registry analytics in-memory relevance
-- Adds lightweight analytics tables for project relevance tracking

-- Project analytics relevance table (in-memory cache for fast lookups)
CREATE TABLE IF NOT EXISTS project_analytics_relevance (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    relevance_score REAL NOT NULL DEFAULT 0.0,
    last_interaction_at INTEGER NOT NULL,
    interaction_count INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES project_registry(id) ON DELETE CASCADE
);

-- Project activity log table (for tracking engagement)
CREATE TABLE IF NOT EXISTS project_activity_log (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    activity_data TEXT,
    timestamp INTEGER NOT NULL,
    user_context TEXT,
    FOREIGN KEY (project_id) REFERENCES project_registry(id) ON DELETE CASCADE
);

-- Create index for project analytics relevance lookups
CREATE INDEX IF NOT EXISTS idx_project_analytics_relevance_project
ON project_analytics_relevance(project_id);

-- Create index for activity log filtering
CREATE INDEX IF NOT EXISTS idx_project_activity_log_project
ON project_activity_log(project_id);

-- Create index for activity log by timestamp
CREATE INDEX IF NOT EXISTS idx_project_activity_log_timestamp
ON project_activity_log(timestamp);
