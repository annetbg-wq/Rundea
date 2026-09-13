-- RUNDEA DOGFOOD GATE v1: workspace-owned nodes and managed host ports.

ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle_status IN ('ACTIVE','ARCHIVED')),
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

UPDATE nodes
   SET workspace_id='00000000-0000-4000-8000-000000000001'::uuid
 WHERE workspace_id IS NULL;

ALTER TABLE nodes ALTER COLUMN workspace_id SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid;
ALTER TABLE nodes ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_archive_state_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_archive_state_check
  CHECK (
    (lifecycle_status='ACTIVE' AND archived_at IS NULL)
    OR (lifecycle_status='ARCHIVED' AND archived_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS nodes_workspace_lifecycle_idx
  ON nodes(workspace_id,lifecycle_status,status,last_seen_at DESC);

CREATE TABLE IF NOT EXISTS service_port_allocations (
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  host_port integer NOT NULL CHECK (host_port BETWEEN 18000 AND 29999),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(service_id,node_id),
  UNIQUE(node_id,host_port)
);

CREATE INDEX IF NOT EXISTS service_port_allocations_node_idx
  ON service_port_allocations(node_id,host_port);

CREATE OR REPLACE FUNCTION rundea_allocate_host_port(input_service_id uuid, input_node_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  existing_port integer;
  candidate integer;
BEGIN
  -- Serialize allocations per node. This prevents two concurrent deployments
  -- from observing the same free candidate before either transaction commits.
  PERFORM pg_advisory_xact_lock(hashtext('rundea-node-port:' || input_node_id::text));

  SELECT host_port INTO existing_port
    FROM service_port_allocations
   WHERE service_id=input_service_id AND node_id=input_node_id;
  IF existing_port IS NOT NULL THEN
    RETURN existing_port;
  END IF;

  SELECT candidate_row.candidate_port INTO candidate
    FROM generate_series(18000,29999) AS candidate_row(candidate_port)
    LEFT JOIN service_port_allocations allocation
      ON allocation.node_id=input_node_id AND allocation.host_port=candidate_row.candidate_port
   WHERE allocation.host_port IS NULL
   ORDER BY candidate_row.candidate_port ASC
   LIMIT 1;

  IF candidate IS NULL THEN
    RAISE EXCEPTION 'no Rundea-managed host ports are available on node %', input_node_id;
  END IF;

  INSERT INTO service_port_allocations(service_id,node_id,host_port)
  VALUES(input_service_id,input_node_id,candidate);

  RETURN candidate;
END;
$$;
