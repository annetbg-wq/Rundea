-- RUNDEA DOGFOOD GATE v1: complete the Service identity cutover.
-- Migration 019 backfilled every prototype-era row. From this point all new
-- service-level state is required to carry the stable project-scoped service_id.

ALTER TABLE deployments ALTER COLUMN service_id SET NOT NULL;
ALTER TABLE service_variables ALTER COLUMN service_id SET NOT NULL;
ALTER TABLE service_domains ALTER COLUMN service_id SET NOT NULL;
ALTER TABLE service_autodeploys ALTER COLUMN service_id SET NOT NULL;
ALTER TABLE github_webhook_deployments ALTER COLUMN service_id SET NOT NULL;
ALTER TABLE runtime_metrics ALTER COLUMN service_id SET NOT NULL;

ALTER TABLE service_variables DROP CONSTRAINT IF EXISTS service_variables_pkey;
ALTER TABLE service_variables ADD CONSTRAINT service_variables_pkey PRIMARY KEY(service_id,key);

ALTER TABLE service_autodeploys DROP CONSTRAINT IF EXISTS service_autodeploys_pkey;
ALTER TABLE service_autodeploys ADD CONSTRAINT service_autodeploys_pkey PRIMARY KEY(service_id);

ALTER TABLE github_webhook_deployments DROP CONSTRAINT IF EXISTS github_webhook_deployments_pkey;
ALTER TABLE github_webhook_deployments ADD CONSTRAINT github_webhook_deployments_pkey PRIMARY KEY(delivery_id,service_id);

-- service_name remains temporarily as a denormalized human/runtime label while
-- Agent commands still use it for container naming. It is no longer an identity
-- or uniqueness boundary anywhere in service-scoped state.
CREATE INDEX IF NOT EXISTS deployments_service_status_idx
  ON deployments(service_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS service_domains_service_status_idx
  ON service_domains(service_id,status,updated_at DESC);
