-- Registry-first rollback may target the node that currently owns the
-- service rather than the historical revision's original node. Persistent
-- volumes remain node-local and therefore continue to forbid cross-node moves.

CREATE OR REPLACE FUNCTION rundea_prepare_deployment_volume_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_service_id uuid;
  target_node_id uuid;
  target_volume_count integer;
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
      SELECT count(*)
        INTO target_volume_count
        FROM deployment_volume_mounts
       WHERE deployment_id=NEW.rollback_target_id;

      IF target_volume_count > 0 THEN
        RAISE EXCEPTION 'cross-node rollback is unavailable for revisions with node-local persistent volumes';
      END IF;
    END IF;

    NEW.service_id := target_service_id;
  END IF;

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
