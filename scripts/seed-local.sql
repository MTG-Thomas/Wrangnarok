-- Synthetic identities and non-secret fixture configuration. Never run remotely.
INSERT INTO groves(id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'Local demo') ON CONFLICT(id) DO NOTHING;
INSERT INTO connections(id, grove_id, realm_id, endpoint) VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', '720b9ebf-9b6a-4eac-bae9-6ed22c970402', 'http://127.0.0.1:8788/echo') ON CONFLICT(id) DO NOTHING;
