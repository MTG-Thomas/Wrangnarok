ALTER TABLE connections ADD COLUMN managed_by TEXT;
CREATE TABLE IF NOT EXISTS bundle_installs(id INTEGER PRIMARY KEY AUTOINCREMENT, bundle_id TEXT NOT NULL, version TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), manifest_hash TEXT NOT NULL, installed_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bundle_installs_lookup ON bundle_installs(bundle_id, org_id);
