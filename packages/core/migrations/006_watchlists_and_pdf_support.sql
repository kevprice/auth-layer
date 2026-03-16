ALTER TABLE captures
  ADD COLUMN IF NOT EXISTS artifact_type TEXT,
  ADD COLUMN IF NOT EXISTS source_label TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS byte_size BIGINT;

UPDATE captures
SET artifact_type = COALESCE(artifact_type, 'url-capture'),
    source_label = COALESCE(source_label, requested_url)
WHERE artifact_type IS NULL OR source_label IS NULL;

CREATE INDEX IF NOT EXISTS captures_artifact_type_idx
  ON captures (artifact_type, created_at DESC);

ALTER TABLE canonical_content_versions
  ADD COLUMN IF NOT EXISTS artifact_type TEXT,
  ADD COLUMN IF NOT EXISTS source_label TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS byte_size BIGINT,
  ADD COLUMN IF NOT EXISTS page_count INTEGER,
  ADD COLUMN IF NOT EXISTS text_available BOOLEAN;

ALTER TABLE metadata_versions
  ADD COLUMN IF NOT EXISTS artifact_type TEXT,
  ADD COLUMN IF NOT EXISTS source_label TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS byte_size BIGINT,
  ADD COLUMN IF NOT EXISTS page_count INTEGER,
  ADD COLUMN IF NOT EXISTS text_available BOOLEAN;

CREATE TABLE IF NOT EXISTS watchlists (
  id TEXT PRIMARY KEY,
  requested_url TEXT NOT NULL,
  normalized_requested_url TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  status TEXT NOT NULL,
  webhook_url TEXT,
  emit_json BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL,
  latest_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS watchlists_due_idx
  ON watchlists (status, next_run_at ASC);

CREATE INDEX IF NOT EXISTS watchlists_normalized_url_idx
  ON watchlists (normalized_requested_url, created_at DESC);

CREATE TABLE IF NOT EXISTS watchlist_runs (
  id TEXT PRIMARY KEY,
  watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,
  previous_capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,
  newer_capture_id TEXT REFERENCES captures(id) ON DELETE SET NULL,
  normalized_requested_url TEXT NOT NULL,
  status TEXT NOT NULL,
  change_detected BOOLEAN,
  change_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  proof_bundle_hashes JSONB NOT NULL DEFAULT '{}'::jsonb,
  checkpoint_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS watchlist_runs_watchlist_idx
  ON watchlist_runs (watchlist_id, created_at DESC);

CREATE TABLE IF NOT EXISTS watchlist_notification_deliveries (
  id TEXT PRIMARY KEY,
  watchlist_run_id TEXT NOT NULL REFERENCES watchlist_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  target TEXT,
  payload JSONB NOT NULL,
  response_status INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS watchlist_notification_deliveries_run_idx
  ON watchlist_notification_deliveries (watchlist_run_id, created_at ASC);
