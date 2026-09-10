-- Remote dev seed. Committed and generic only: the smoke Organization row
-- required by the executions.org_id foreign key. No connections, no
-- endpoints, no credentials: smoke needs none, and real endpoints live in
-- local override files or future install manifests, never here.
-- Applied by runbook command only; never hand-edited remotely.
INSERT INTO organizations(id, name) VALUES ('11111111-1111-4111-8111-111111111111', 'org_system_smoke') ON CONFLICT(id) DO NOTHING;
