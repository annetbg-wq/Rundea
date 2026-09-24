CREATE TABLE IF NOT EXISTS registry_pull_tickets (
  deployment_id uuid PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  registry_host text NOT NULL CHECK (length(registry_host) BETWEEN 1 AND 255),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registry_pull_tickets_node_idx
  ON registry_pull_tickets(node_id, expires_at);
