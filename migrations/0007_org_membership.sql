ALTER TABLE organizations ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE organizations ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE organizations ADD COLUMN disabled_at TEXT;
CREATE TABLE IF NOT EXISTS users(user_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, disabled_at TEXT);
CREATE TABLE IF NOT EXISTS org_memberships(org_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL REFERENCES users(user_id), role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'invited', kind TEXT NOT NULL DEFAULT 'ordinary', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id, user_id));
CREATE INDEX IF NOT EXISTS org_memberships_user ON org_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS org_memberships_org ON org_memberships(org_id, status);
