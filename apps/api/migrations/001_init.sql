CREATE TABLE IF NOT EXISTS nodes (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  token_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('ONLINE','OFFLINE')),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
  id uuid PRIMARY KEY,
  service_name text NOT NULL,
  node_id uuid NOT NULL REFERENCES nodes(id),
  source_repository text NOT NULL,
  source_ref text NOT NULL,
  dockerfile text NOT NULL DEFAULT 'Dockerfile',
  container_port integer NOT NULL CHECK (container_port BETWEEN 1 AND 65535),
  host_port integer NOT NULL CHECK (host_port BETWEEN 1 AND 65535),
  healthcheck_path text NOT NULL DEFAULT '/health',
  status text NOT NULL CHECK (status IN ('QUEUED','BUILDING','DEPLOYING','HEALTHCHECK','READY','FAILED','CANCELLED','ROLLED_BACK')),
  runtime_container_id text,
  dispatch_attempt integer NOT NULL DEFAULT 0,
  dispatch_lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deployments_node_status_idx ON deployments(node_id, status, created_at);

CREATE TABLE IF NOT EXISTS deployment_events (
  id bigserial PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('STATUS','LOG')),
  status text,
  stream text,
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deployment_events_deployment_idx ON deployment_events(deployment_id, id);
