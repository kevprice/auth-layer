ALTER TABLE transparency_log_checkpoints
  ADD COLUMN IF NOT EXISTS operator_id TEXT;

ALTER TABLE transparency_log_checkpoints
  ADD COLUMN IF NOT EXISTS operator_public_key_sha256 TEXT;

ALTER TABLE transparency_log_checkpoints
  ADD COLUMN IF NOT EXISTS signature_algorithm TEXT;

ALTER TABLE transparency_log_checkpoints
  ADD COLUMN IF NOT EXISTS checkpoint_hash TEXT;

ALTER TABLE transparency_log_checkpoints
  ADD COLUMN IF NOT EXISTS previous_checkpoint_id TEXT;

ALTER TABLE transparency_log_checkpoints
  ADD COLUMN IF NOT EXISTS previous_checkpoint_hash TEXT;

UPDATE transparency_log_checkpoints
SET
  operator_id = COALESCE(operator_id, 'legacy-operator'),
  operator_public_key_sha256 = COALESCE(operator_public_key_sha256, 'sha256:legacy'),
  signature_algorithm = COALESCE(signature_algorithm, 'ed25519'),
  checkpoint_hash = COALESCE(checkpoint_hash, checkpoint_id)
WHERE
  operator_id IS NULL
  OR operator_public_key_sha256 IS NULL
  OR signature_algorithm IS NULL
  OR checkpoint_hash IS NULL;

ALTER TABLE transparency_log_checkpoints
  ALTER COLUMN operator_id SET NOT NULL;

ALTER TABLE transparency_log_checkpoints
  ALTER COLUMN operator_public_key_sha256 SET NOT NULL;

ALTER TABLE transparency_log_checkpoints
  ALTER COLUMN signature_algorithm SET NOT NULL;

ALTER TABLE transparency_log_checkpoints
  ALTER COLUMN checkpoint_hash SET NOT NULL;

CREATE INDEX IF NOT EXISTS transparency_log_checkpoints_operator_idx
  ON transparency_log_checkpoints (operator_id, log_key_id, issued_at DESC);
