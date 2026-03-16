ALTER TABLE captures
  ADD COLUMN IF NOT EXISTS screenshot_hash TEXT,
  ADD COLUMN IF NOT EXISTS rendered_evidence JSONB;

CREATE TABLE IF NOT EXISTS approval_receipt_events (
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  receipt_id TEXT NOT NULL,
  actor_account_id TEXT NOT NULL,
  approval_type TEXT NOT NULL,
  raw_pdf_hash TEXT NOT NULL,
  receipt JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (capture_id, version),
  UNIQUE (receipt_id)
);

CREATE INDEX IF NOT EXISTS approval_receipt_events_lookup_idx
  ON approval_receipt_events (capture_id, version DESC);
