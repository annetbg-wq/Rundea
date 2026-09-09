ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS credential_state text;

UPDATE nodes
SET credential_state='ACTIVE'
WHERE credential_state IS NULL;

ALTER TABLE nodes
  ALTER COLUMN credential_state SET DEFAULT 'ACTIVE';

ALTER TABLE nodes
  ALTER COLUMN credential_state SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='nodes_credential_state_check'
      AND conrelid='nodes'::regclass
  ) THEN
    ALTER TABLE nodes
      ADD CONSTRAINT nodes_credential_state_check
      CHECK (credential_state IN ('BOOTSTRAP','ACTIVE'));
  END IF;
END $$;
