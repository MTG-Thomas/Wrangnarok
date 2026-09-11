CREATE TABLE forms(id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, saga_id TEXT NOT NULL, fields_json TEXT NOT NULL CHECK(length(fields_json) <= 4096), created_at TEXT NOT NULL, UNIQUE(org_id, name));
CREATE INDEX forms_org ON forms(org_id);
