CREATE TABLE IF NOT EXISTS service_autodeploys (
  service_name text PRIMARY KEY CHECK (service_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  repository_full_name text NOT NULL CHECK (repository_full_name ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'),
  source_repository text NOT NULL,
  source_branch text NOT NULL,
  dockerfile text,
  container_port integer NOT NULL CHECK (container_port BETWEEN 1 AND 65535),
  host_port integer NOT NULL CHECK (host_port BETWEEN 1 AND 65535),
  healthcheck_path text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_autodeploys_repo_branch_idx
  ON service_autodeploys(repository_full_name, source_branch)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id text PRIMARY KEY CHECK (length(delivery_id) BETWEEN 1 AND 200),
  body_sha256 text CHECK (body_sha256 IS NULL OR body_sha256 ~ '^[0-9a-f]{64}$'),
  event_name text NOT NULL CHECK (length(event_name) BETWEEN 1 AND 80),
  repository_full_name text,
  source_branch text,
  after_sha text,
  status text NOT NULL CHECK (status IN ('RECEIVED','TRIGGERED','IGNORED')),
  deployment_count integer NOT NULL DEFAULT 0 CHECK (deployment_count >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE github_webhook_deliveries
  ADD COLUMN IF NOT EXISTS body_sha256 text;

CREATE UNIQUE INDEX IF NOT EXISTS github_webhook_deliveries_body_sha256_idx
  ON github_webhook_deliveries(body_sha256)
  WHERE body_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS github_webhook_deployments (
  delivery_id text NOT NULL REFERENCES github_webhook_deliveries(delivery_id) ON DELETE CASCADE,
  service_name text NOT NULL,
  deployment_id uuid NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  PRIMARY KEY (delivery_id, service_name)
);
