ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS build_args jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE service_autodeploys
  ADD COLUMN IF NOT EXISTS build_args jsonb NOT NULL DEFAULT '{}'::jsonb;
