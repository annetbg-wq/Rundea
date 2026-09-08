ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'DEPLOY',
  ADD COLUMN IF NOT EXISTS rollback_target_id uuid REFERENCES deployments(id),
  ADD COLUMN IF NOT EXISTS environment_snapshot_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_commit_sha text,
  ADD COLUMN IF NOT EXISTS image_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deployments_operation_check'
  ) THEN
    ALTER TABLE deployments ADD CONSTRAINT deployments_operation_check CHECK (operation IN ('DEPLOY','ROLLBACK'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deployments_source_commit_sha_check'
  ) THEN
    ALTER TABLE deployments ADD CONSTRAINT deployments_source_commit_sha_check
      CHECK (source_commit_sha IS NULL OR source_commit_sha ~ '^[0-9a-f]{40}$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS deployment_variables (
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  key text NOT NULL,
  encrypted_version smallint NOT NULL DEFAULT 1 CHECK (encrypted_version = 1),
  iv text NOT NULL,
  ciphertext text NOT NULL,
  auth_tag text NOT NULL,
  is_secret boolean NOT NULL DEFAULT true,
  PRIMARY KEY(deployment_id, key),
  CHECK (key ~ '^[A-Za-z_][A-Za-z0-9_]*$')
);

CREATE INDEX IF NOT EXISTS deployment_variables_deployment_idx ON deployment_variables(deployment_id);

CREATE TABLE IF NOT EXISTS runtime_actions (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('RESTART')),
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_actions_one_restart_idx
  ON runtime_actions(deployment_id) WHERE kind='RESTART' AND status='RUNNING';
CREATE INDEX IF NOT EXISTS runtime_actions_created_idx ON runtime_actions(created_at DESC);
