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

ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS bootstrap_token_hash char(64),
  ADD COLUMN IF NOT EXISTS bootstrap_expires_at timestamptz;

-- Existing rows keep their active Agent credential in token_hash. New node
-- creation still uses the original INSERT contract, but the trigger moves the
-- returned token into a bootstrap-only slot. The Agent WebSocket continues to
-- authenticate only token_hash, so a fresh bootstrap token cannot act as an
-- Agent before it is exchanged.
CREATE OR REPLACE FUNCTION rundea_initialize_node_bootstrap_credential()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.bootstrap_token_hash IS NULL THEN
    NEW.bootstrap_token_hash := NEW.token_hash;
    NEW.bootstrap_expires_at := now() + interval '30 minutes';
    NEW.token_hash := repeat('0', 64);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rundea_nodes_bootstrap_credential ON nodes;
CREATE TRIGGER rundea_nodes_bootstrap_credential
BEFORE INSERT ON nodes
FOR EACH ROW
EXECUTE FUNCTION rundea_initialize_node_bootstrap_credential();
