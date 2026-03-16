ALTER TABLE captures ADD COLUMN IF NOT EXISTS content_type TEXT;
ALTER TABLE captures ADD COLUMN IF NOT EXISTS charset TEXT;
ALTER TABLE captures ADD COLUMN IF NOT EXISTS compared_to_capture_id TEXT;
ALTER TABLE captures ADD COLUMN IF NOT EXISTS title_changed_from_previous BOOLEAN;
ALTER TABLE captures ADD COLUMN IF NOT EXISTS author_changed_from_previous BOOLEAN;
ALTER TABLE captures ADD COLUMN IF NOT EXISTS claimed_published_at_changed_from_previous BOOLEAN;

ALTER TABLE proof_bundle_versions ADD COLUMN IF NOT EXISTS raw_snapshot_schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE proof_bundle_versions ADD COLUMN IF NOT EXISTS canonical_content_schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE proof_bundle_versions ADD COLUMN IF NOT EXISTS metadata_schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE proof_bundle_versions ADD COLUMN IF NOT EXISTS capture_scope JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS transparency_log_entries (
  schema_version INTEGER NOT NULL,
  log_index INTEGER PRIMARY KEY,
  capture_id TEXT NOT NULL UNIQUE REFERENCES captures(id) ON DELETE CASCADE,
  proof_bundle_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL UNIQUE,
  previous_entry_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS transparency_log_entries_capture_idx
  ON transparency_log_entries (capture_id);

CREATE INDEX IF NOT EXISTS transparency_log_entries_created_idx
  ON transparency_log_entries (created_at DESC);

CREATE TABLE IF NOT EXISTS transparency_log_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  tree_size INTEGER NOT NULL,
  last_log_index INTEGER NOT NULL,
  last_entry_hash TEXT NOT NULL,
  root_hash TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  log_key_id TEXT NOT NULL,
  signature TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS transparency_log_checkpoints_issued_idx
  ON transparency_log_checkpoints (issued_at DESC);
