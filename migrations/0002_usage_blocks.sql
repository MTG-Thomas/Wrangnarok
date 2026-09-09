CREATE TABLE IF NOT EXISTS usage_blocks (execution_id TEXT PRIMARY KEY REFERENCES executions(id), usage_json TEXT NOT NULL CHECK(length(usage_json) <= 4096), created_at TEXT NOT NULL);
