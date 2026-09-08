CREATE TABLE IF NOT EXISTS github_repository_installations (
  repository_full_name text PRIMARY KEY CHECK (repository_full_name ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'),
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_grants (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  repository_full_name text NOT NULL REFERENCES github_repository_installations(repository_full_name) ON DELETE RESTRICT,
  source_commit_sha text NOT NULL CHECK (source_commit_sha ~ '^[0-9a-f]{40}$'),
  expires_at timestamptz NOT NULL,
  lease_until timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_grants_node_expiry_idx
  ON source_grants(node_id, expires_at)
  WHERE consumed_at IS NULL;
