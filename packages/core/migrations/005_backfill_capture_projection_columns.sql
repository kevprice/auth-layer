ALTER TABLE captures
  ADD COLUMN IF NOT EXISTS final_url TEXT,
  ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_published_at TEXT,
  ADD COLUMN IF NOT EXISTS http_status INTEGER,
  ADD COLUMN IF NOT EXISTS headers JSONB,
  ADD COLUMN IF NOT EXISTS content_type TEXT,
  ADD COLUMN IF NOT EXISTS charset TEXT,
  ADD COLUMN IF NOT EXISTS raw_snapshot_hash TEXT,
  ADD COLUMN IF NOT EXISTS canonical_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS metadata_hash TEXT,
  ADD COLUMN IF NOT EXISTS proof_bundle_hash TEXT,
  ADD COLUMN IF NOT EXISTS proof_receipt_id TEXT,
  ADD COLUMN IF NOT EXISTS normalization_version TEXT,
  ADD COLUMN IF NOT EXISTS hash_algorithm TEXT,
  ADD COLUMN IF NOT EXISTS canonical_content_schema_version INTEGER,
  ADD COLUMN IF NOT EXISTS metadata_schema_version INTEGER,
  ADD COLUMN IF NOT EXISTS latest_event_sequence INTEGER,
  ADD COLUMN IF NOT EXISTS latest_canonical_content_version INTEGER,
  ADD COLUMN IF NOT EXISTS latest_metadata_version INTEGER,
  ADD COLUMN IF NOT EXISTS latest_proof_bundle_version INTEGER,
  ADD COLUMN IF NOT EXISTS latest_receipt_version INTEGER,
  ADD COLUMN IF NOT EXISTS compared_to_capture_id TEXT,
  ADD COLUMN IF NOT EXISTS page_kind TEXT,
  ADD COLUMN IF NOT EXISTS content_extraction_status TEXT,
  ADD COLUMN IF NOT EXISTS metadata_changed_from_previous BOOLEAN,
  ADD COLUMN IF NOT EXISTS content_changed_from_previous BOOLEAN,
  ADD COLUMN IF NOT EXISTS title_changed_from_previous BOOLEAN,
  ADD COLUMN IF NOT EXISTS author_changed_from_previous BOOLEAN,
  ADD COLUMN IF NOT EXISTS claimed_published_at_changed_from_previous BOOLEAN,
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS actor_account_id TEXT,
  ADD COLUMN IF NOT EXISTS approval_receipt_id TEXT,
  ADD COLUMN IF NOT EXISTS approval_type TEXT,
  ADD COLUMN IF NOT EXISTS artifacts JSONB;

UPDATE captures
SET latest_event_sequence = COALESCE(latest_event_sequence, 0),
    artifacts = COALESCE(artifacts, '{}'::jsonb)
WHERE latest_event_sequence IS NULL
   OR artifacts IS NULL;

ALTER TABLE captures
  ALTER COLUMN latest_event_sequence SET DEFAULT 0,
  ALTER COLUMN latest_event_sequence SET NOT NULL,
  ALTER COLUMN artifacts SET DEFAULT '{}'::jsonb,
  ALTER COLUMN artifacts SET NOT NULL;

CREATE INDEX IF NOT EXISTS captures_normalized_requested_url_idx
  ON captures (normalized_requested_url, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS captures_proof_receipt_id_uidx
  ON captures (proof_receipt_id)
  WHERE proof_receipt_id IS NOT NULL;
