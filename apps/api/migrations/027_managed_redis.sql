-- Project-scoped managed Redis. The addon belongs to exactly one canonical
-- project and is pinned to exactly one node once the project first deploys.
-- Redis is never assigned a host port; applications reach it only through the
-- Rundea-owned project Docker network.

CREATE TABLE IF NOT EXISTS project_redis_addons (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
  node_id uuid REFERENCES nodes(id) ON DELETE RESTRICT,
  alias text NOT NULL DEFAULT 'redis',
  docker_volume_name text NOT NULL UNIQUE,
  encrypted_version integer NOT NULL,
  iv text NOT NULL,
  ciphertext text NOT NULL,
  auth_tag text NOT NULL,
  status text NOT NULL DEFAULT 'CONFIGURED',
  last_error text,
  ready_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (alias ~ '^[a-z][a-z0-9-]{0,62}$'),
  CHECK (docker_volume_name ~ '^rundea-redis-[a-f0-9]{32}$'),
  CHECK (status IN ('CONFIGURED','READY','FAILED'))
);

CREATE INDEX IF NOT EXISTS project_redis_addons_node_idx
  ON project_redis_addons(node_id,status,project_id);

-- Stateful project addons and project services must stay on the same node.
-- Canonical deploy paths already submit service_id. Legacy prototype inserts
-- without service_id are intentionally ignored here and remain outside managed
-- addon scope.
CREATE OR REPLACE FUNCTION rundea_bind_managed_redis_node()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  deployment_project_id uuid;
  addon_node_id uuid;
BEGIN
  IF NEW.service_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT project_id INTO deployment_project_id
    FROM services
   WHERE id=NEW.service_id;
  IF deployment_project_id IS NULL THEN
    RAISE EXCEPTION 'deployment service has no canonical project';
  END IF;

  SELECT node_id INTO addon_node_id
    FROM project_redis_addons
   WHERE project_id=deployment_project_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF addon_node_id IS NULL THEN
    UPDATE project_redis_addons
       SET node_id=NEW.node_id,updated_at=now()
     WHERE project_id=deployment_project_id;
  ELSIF addon_node_id <> NEW.node_id THEN
    RAISE EXCEPTION 'managed Redis is pinned to node %, deployment requested node %', addon_node_id, NEW.node_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deployments_managed_redis_node_scope ON deployments;
CREATE TRIGGER deployments_managed_redis_node_scope
BEFORE INSERT ON deployments
FOR EACH ROW EXECUTE FUNCTION rundea_bind_managed_redis_node();
