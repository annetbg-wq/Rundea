-- First-class node-local durable volumes. A volume belongs to exactly one
-- canonical service and, once a stateful deployment is created, to exactly one
-- Rundea node. Normal service/deployment lifecycle never cascades into the
-- durable volume record.

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
  CHECK (mount_path ~ '^/[^,\r\n\x00]+$'),
  CHECK (mount_path <> '/'),
  CHECK (mount_path !~ '(^|/)\.\.(/|$)'),
  CHECK (docker_volume_name ~ '^rundea-vol-[a-f0-9]{32}$')
);

CREATE INDEX IF NOT EXISTS service_volumes_service_node_idx
  ON service_volumes(service_id,node_id,created_at,id);

-- Deployment snapshots make mount configuration immutable. A rollback uses
-- the target revision's snapshot rather than whatever the service happens to
-- be configured with later.
CREATE TABLE IF NOT EXISTS deployment_volume_mounts (
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  volume_id uuid NOT NULL REFERENCES service_volumes(id) ON DELETE RESTRICT,
  docker_volume_name text NOT NULL,
  mount_path text NOT NULL,
  PRIMARY KEY(deployment_id,volume_id),
  UNIQUE(deployment_id,mount_path),
  CHECK (mount_path ~ '^/[^,\r\n\x00]+$'),
  CHECK (mount_path <> '/'),
  CHECK (mount_path !~ '(^|/)\.\.(/|$)'),
  CHECK (docker_volume_name ~ '^rundea-vol-[a-f0-9]{32}$')
);

CREATE INDEX IF NOT EXISTS deployment_volume_mounts_volume_idx
  ON deployment_volume_mounts(volume_id,deployment_id);

-- This trigger is deliberately ordered before the legacy service-scope trigger
-- from migration 020. Canonical rollback rows created by the older runtime
-- operation path omitted service_id; here we inherit and verify the target
-- service identity instead of allowing the row to fall into the hidden legacy
-- service bucket.
CREATE OR REPLACE FUNCTION rundea_prepare_deployment_volume_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_service_id uuid;
  target_node_id uuid;
  bound_node_id uuid;
  conflicting_node_count integer;
BEGIN
  IF NEW.operation = 'ROLLBACK' THEN
    IF NEW.rollback_target_id IS NULL THEN
      RAISE EXCEPTION 'rollback deployment requires rollback_target_id';
    END IF;
    SELECT service_id,node_id
      INTO target_service_id,target_node_id
      FROM deployments
     WHERE id=NEW.rollback_target_id;
    IF target_service_id IS NULL THEN
      RAISE EXCEPTION 'rollback target is unavailable';
    END IF;
    IF NEW.service_id IS NOT NULL AND NEW.service_id <> target_service_id THEN
      RAISE EXCEPTION 'rollback service_id does not match target revision';
    END IF;
    IF NEW.node_id <> target_node_id THEN
      RAISE EXCEPTION 'rollback node does not match target revision';
    END IF;
    NEW.service_id := target_service_id;
  END IF;

  -- Serialize stateful placement changes for this service before inspecting or
  -- assigning the node binding.
  PERFORM id
    FROM service_volumes
   WHERE service_id=NEW.service_id
   ORDER BY id
   FOR UPDATE;

  SELECT count(DISTINCT node_id), min(node_id::text)::uuid
    INTO conflicting_node_count,bound_node_id
    FROM service_volumes
   WHERE service_id=NEW.service_id
     AND node_id IS NOT NULL;

  IF conflicting_node_count > 1 THEN
    RAISE EXCEPTION 'service persistent volumes are bound to conflicting nodes';
  END IF;
  IF bound_node_id IS NOT NULL AND bound_node_id <> NEW.node_id THEN
    RAISE EXCEPTION 'persistent volumes are pinned to node %, deployment requested node %', bound_node_id, NEW.node_id;
  END IF;

  UPDATE service_volumes
     SET node_id=NEW.node_id,updated_at=now()
   WHERE service_id=NEW.service_id
     AND node_id IS NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deployments_00_persistent_volume_scope ON deployments;
CREATE TRIGGER deployments_00_persistent_volume_scope
BEFORE INSERT ON deployments
FOR EACH ROW EXECUTE FUNCTION rundea_prepare_deployment_volume_scope();

CREATE OR REPLACE FUNCTION rundea_snapshot_deployment_volumes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.operation = 'ROLLBACK' THEN
    INSERT INTO deployment_volume_mounts(deployment_id,volume_id,docker_volume_name,mount_path)
    SELECT NEW.id,volume_id,docker_volume_name,mount_path
      FROM deployment_volume_mounts
     WHERE deployment_id=NEW.rollback_target_id
     ORDER BY volume_id;
  ELSE
    INSERT INTO deployment_volume_mounts(deployment_id,volume_id,docker_volume_name,mount_path)
    SELECT NEW.id,id,docker_volume_name,mount_path
      FROM service_volumes
     WHERE service_id=NEW.service_id
     ORDER BY created_at,id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS deployments_snapshot_persistent_volumes ON deployments;
CREATE TRIGGER deployments_snapshot_persistent_volumes
AFTER INSERT ON deployments
FOR EACH ROW EXECUTE FUNCTION rundea_snapshot_deployment_volumes();
