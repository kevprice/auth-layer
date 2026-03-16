ALTER TABLE transparency_log_checkpoints
  ADD COLUMN IF NOT EXISTS log_mode TEXT;

UPDATE transparency_log_checkpoints
SET log_mode = COALESCE(log_mode, 'legacy-hash-chain')
WHERE log_mode IS NULL;

ALTER TABLE transparency_log_checkpoints
  ALTER COLUMN log_mode SET NOT NULL;
