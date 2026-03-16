-- Schema snapshot. SQL migrations in packages/core/migrations are the source of truth.

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  requested_url TEXT NOT NULL,
  normalized_requested_url TEXT NOT NULL,
  final_url TEXT,
  fetched_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ,
  claimed_published_at TEXT,
  http_status INTEGER,
  headers JSONB,
  content_type TEXT,
  charset TEXT,
  raw_snapshot_hash TEXT,
  canonical_content_hash TEXT,
  metadata_hash TEXT,
  proof_bundle_hash TEXT,
  proof_receipt_id TEXT,
  extractor_version TEXT NOT NULL,
  normalization_version TEXT,
  hash_algorithm TEXT,
  canonical_content_schema_version INTEGER,
  metadata_schema_version INTEGER,
  latest_event_sequence INTEGER NOT NULL DEFAULT 0,
  latest_canonical_content_version INTEGER,
  latest_metadata_version INTEGER,
  latest_proof_bundle_version INTEGER,
  latest_receipt_version INTEGER,
  compared_to_capture_id TEXT,
  status TEXT NOT NULL,
  page_kind TEXT,
  content_extraction_status TEXT,
  metadata_changed_from_previous BOOLEAN,
  content_changed_from_previous BOOLEAN,
  title_changed_from_previous BOOLEAN,
  author_changed_from_previous BOOLEAN,
  claimed_published_at_changed_from_previous BOOLEAN,
  error_code TEXT,
  error_message TEXT,
  actor_account_id TEXT,
  approval_receipt_id TEXT,
  approval_type TEXT,
  approval_scope TEXT,
  approval_method TEXT,
  artifacts JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS captures_normalized_requested_url_idx
  ON captures (normalized_requested_url, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS captures_proof_receipt_id_uidx
  ON captures (proof_receipt_id)
  WHERE proof_receipt_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS capture_events (
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (capture_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS capture_events_lookup_idx
  ON capture_events (capture_id, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_content_versions (
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  normalization_version TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  page_kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  title TEXT,
  subtitle TEXT,
  author TEXT,
  published_at_claimed TEXT,
  stats JSONB NOT NULL,
  diagnostics JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (capture_id, version)
);

CREATE INDEX IF NOT EXISTS canonical_content_versions_lookup_idx
  ON canonical_content_versions (capture_id, version DESC);

CREATE INDEX IF NOT EXISTS canonical_content_versions_hash_idx
  ON canonical_content_versions (content_hash);

CREATE TABLE IF NOT EXISTS metadata_versions (
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  normalization_version TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  metadata_hash TEXT NOT NULL,
  canonical_url TEXT,
  title TEXT,
  subtitle TEXT,
  author TEXT,
  published_at_claimed TEXT,
  language TEXT,
  field_provenance JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (capture_id, version)
);

CREATE INDEX IF NOT EXISTS metadata_versions_lookup_idx
  ON metadata_versions (capture_id, version DESC);

CREATE INDEX IF NOT EXISTS metadata_versions_hash_idx
  ON metadata_versions (metadata_hash);

CREATE TABLE IF NOT EXISTS proof_bundle_versions (
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  normalization_version TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL,
  raw_snapshot_schema_version INTEGER NOT NULL,
  canonical_content_schema_version INTEGER NOT NULL,
  metadata_schema_version INTEGER NOT NULL,
  capture_scope JSONB NOT NULL,
  proof_bundle_hash TEXT NOT NULL,
  receipt_id TEXT,
  bundle JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (capture_id, version)
);

CREATE INDEX IF NOT EXISTS proof_bundle_versions_lookup_idx
  ON proof_bundle_versions (capture_id, version DESC);

CREATE INDEX IF NOT EXISTS proof_bundle_versions_hash_idx
  ON proof_bundle_versions (proof_bundle_hash);

CREATE TABLE IF NOT EXISTS receipt_events (
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  receipt_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  proof_bundle_hash TEXT NOT NULL,
  receipt JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (capture_id, version),
  UNIQUE (receipt_id)
);

CREATE INDEX IF NOT EXISTS receipt_events_lookup_idx
  ON receipt_events (capture_id, version DESC);

CREATE TABLE IF NOT EXISTS artifact_references (
  id BIGSERIAL PRIMARY KEY,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_type TEXT,
  byte_size INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (capture_id, kind, version)
);

CREATE INDEX IF NOT EXISTS artifact_references_lookup_idx
  ON artifact_references (capture_id, kind, version DESC);

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
  operator_id TEXT NOT NULL,
  log_key_id TEXT NOT NULL,
  operator_public_key_sha256 TEXT NOT NULL,
  signature_algorithm TEXT NOT NULL,
  log_mode TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  previous_checkpoint_id TEXT,
  previous_checkpoint_hash TEXT,
  signature TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS transparency_log_checkpoints_issued_idx
  ON transparency_log_checkpoints (issued_at DESC);



