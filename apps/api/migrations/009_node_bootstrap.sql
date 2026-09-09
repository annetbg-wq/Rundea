ALTER TABLE nodes ADD COLUMN IF NOT EXISTS bootstrap_token_hash char(64);
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS bootstrap_expires_at timestamptz;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS bootstrap_consumed_at timestamptz;

CREATE INDEX IF NOT EXISTS nodes_bootstrap_expiry_idx
  ON nodes(bootstrap_expires_at)
  WHERE bootstrap_token_hash IS NOT NULL;
