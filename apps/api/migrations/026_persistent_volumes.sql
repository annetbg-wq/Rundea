-- First-class node-local durable volumes. A volume belongs to exactly one
-- canonical service and may become pinned to exactly one Rundea node. Normal
-- service/deployment lifecycle never cascades into service_volumes.

CREATE TABLE IF NOT EXISTS service_volumes (
  id uuid PRIMARY KEY,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  name text NOT NULL,
  mount_path text NOT NULL,
  node_id uuid REFERENCES nodes(id) ON DELETE RESTRICT,
  docker_volume_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(service_id,name),
  UNIQUE(service_id,mount_path),
  CHECK (name ~ '^[a-z][a-z0-9-]{0,62}$'),
  CHECK (mount_path ~ '^/[^\r\n\x00]+$'),
  CHECK (mount_path <> '/'),
  CHECK (mount_path !~ '(^|/)\.\.(/|$)'),
  CHECK (docker_volume_name ~ '^rundea-vol-[a-f0-9]{32}$')
);

CREATE INDEX IF NOT EXISTS service_volumes_service_node_idx
  ON service_volumes(service_id,node_id,created_at,id);

-- Deployment snapshots make mount configuration immutable for deploy and
-- rollback even if service-level configuration changes later.
CREATE TABLE IF NOT EXISTS deployment_volume_mounts (
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  volume_id uuid NOT NULL REFERENCES service_volumes(id) ON DELETE RESTRICT,
  docker_volume_name text NOT NULL,
  mount_path text NOT NULL,
  PRIMARY KEY(deployment_id,volume_id),
  UNIQUE(deployment_id,mount_path),
  CHECK (mount_path ~ '^/[^\r\n\x00]+$'),
  CHECK (mount_path <> '/'),
  CHECK (mount_path !~ '(^|/)\.\.(/|$)'),
  CHECK (docker_volume_name ~ '^rundea-vol-[a-f0-9]{32}$')
);

CREATE INDEX IF NOT EXISTS deployment_volume_mounts_volume_idx
  ON deployment_volume_mounts(volume_id,deployment_id);
