ALTER TABLE watchlists
  ADD COLUMN IF NOT EXISTS interval_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_successful_fetch_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_state_change_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_http_status INTEGER,
  ADD COLUMN IF NOT EXISTS last_resolved_url TEXT,
  ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS burst_config JSONB;

UPDATE watchlists
SET interval_seconds = COALESCE(interval_seconds, interval_minutes * 60)
WHERE interval_seconds IS NULL;

ALTER TABLE watchlists
  ALTER COLUMN interval_seconds SET NOT NULL;

UPDATE watchlists
SET status = 'active'
WHERE status IS NULL;

ALTER TABLE watchlist_runs
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS http_status INTEGER,
  ADD COLUMN IF NOT EXISTS resolved_url TEXT,
  ADD COLUMN IF NOT EXISTS previous_resolved_url TEXT,
  ADD COLUMN IF NOT EXISTS state_changed BOOLEAN,
  ADD COLUMN IF NOT EXISTS availability_transition TEXT,
  ADD COLUMN IF NOT EXISTS redirect_changed BOOLEAN;
