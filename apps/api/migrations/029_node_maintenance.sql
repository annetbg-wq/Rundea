ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_lifecycle_status_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_lifecycle_status_check
  CHECK (lifecycle_status IN ('ACTIVE','MAINTENANCE','ARCHIVED'));

ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_archive_state_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_archive_state_check
  CHECK (
    (lifecycle_status IN ('ACTIVE','MAINTENANCE') AND archived_at IS NULL)
    OR (lifecycle_status='ARCHIVED' AND archived_at IS NOT NULL)
  );

CREATE TABLE IF NOT EXISTS node_maintenance_actions (
  id uuid PRIMARY KEY,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('UPDATE_AGENT','CLEANUP_NODE')),
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error text,
  result_agent_version text,
  result_build_sha text
);

CREATE UNIQUE INDEX IF NOT EXISTS node_maintenance_one_running_idx
  ON node_maintenance_actions(node_id)
  WHERE status='RUNNING';

CREATE INDEX IF NOT EXISTS node_maintenance_node_requested_idx
  ON node_maintenance_actions(node_id, requested_at DESC);
