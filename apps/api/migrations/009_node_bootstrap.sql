ALTER TABLE nodes ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS bootstrap_token_hash char(64);
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS bootstrap_expires_at timestamptz;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS bootstrap_consumed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nodes_has_credential_check'
  ) THEN
    ALTER TABLE nodes
      ADD CONSTRAINT nodes_has_credential_check
      CHECK (token_hash IS NOT NULL OR bootstrap_token_hash IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS nodes_bootstrap_expiry_idx
  ON nodes(bootstrap_expires_at)
  WHERE bootstrap_token_hash IS NOT NULL;
