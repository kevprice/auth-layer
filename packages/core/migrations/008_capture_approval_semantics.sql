ALTER TABLE captures
  ADD COLUMN IF NOT EXISTS approval_scope TEXT,
  ADD COLUMN IF NOT EXISTS approval_method TEXT;
