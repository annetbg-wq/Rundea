ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS source_delivery text NOT NULL DEFAULT 'DIRECT';

DO $$
BEGIN
  ALTER TABLE deployments
    ADD CONSTRAINT deployments_source_delivery_check
    CHECK (source_delivery IN ('DIRECT','BROKER'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS source_bundle_tickets (
  deployment_id uuid PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  repository_full_name text NOT NULL CHECK (repository_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_bundle_tickets_node_idx
  ON source_bundle_tickets(node_id, expires_at);
