CREATE TABLE agent_postings (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  track TEXT NOT NULL,
  provenance TEXT NOT NULL,
  evidence TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);
CREATE TABLE application_batches (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  snapshot TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approval TEXT
);
ALTER TABLE attempts ADD COLUMN runner TEXT NOT NULL DEFAULT 'backup';
ALTER TABLE attempts ADD COLUMN batch_id TEXT;
ALTER TABLE attempts ADD COLUMN identity TEXT;
CREATE UNIQUE INDEX one_application_identity ON attempts(identity);
INSERT OR IGNORE INTO settings VALUES ('agent_submissions_enabled','false'),('muse_connection_tested','false'),('muse_upload_tested','false'),('agent_launched','false');
