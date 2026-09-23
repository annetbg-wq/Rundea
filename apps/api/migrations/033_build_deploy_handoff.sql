ALTER TABLE build_jobs
  ADD COLUMN IF NOT EXISTS deploy_after_push boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deployment_id uuid REFERENCES deployments(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS build_jobs_deployment_idx
  ON build_jobs(deployment_id)
  WHERE deployment_id IS NOT NULL;
