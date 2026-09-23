ALTER TABLE build_jobs
  ADD COLUMN IF NOT EXISTS deploy_after_push boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS target_service_name text,
  ADD COLUMN IF NOT EXISTS target_node_id uuid REFERENCES nodes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_container_port integer,
  ADD COLUMN IF NOT EXISTS target_host_port integer,
  ADD COLUMN IF NOT EXISTS target_healthcheck_path text,
  ADD COLUMN IF NOT EXISTS deployment_id uuid UNIQUE REFERENCES deployments(id) ON DELETE SET NULL;

ALTER TABLE build_jobs DROP CONSTRAINT IF EXISTS build_jobs_deploy_target_check;
ALTER TABLE build_jobs ADD CONSTRAINT build_jobs_deploy_target_check CHECK (
  NOT deploy_after_push OR (
    target_service_name IS NOT NULL
    AND target_node_id IS NOT NULL
    AND target_container_port BETWEEN 1 AND 65535
    AND target_host_port BETWEEN 1 AND 65535
    AND target_healthcheck_path IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS build_jobs_deployment_idx
  ON build_jobs(deployment_id)
  WHERE deployment_id IS NOT NULL;
