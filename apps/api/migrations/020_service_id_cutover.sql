-- RUNDEA DOGFOOD GATE v1: complete the stable Service identity cutover.
--
-- Migration 019 introduced and backfilled project-scoped service UUIDs. This
-- migration makes service_id mandatory for all service-scoped state. Prototype
-- callers that still submit only service_name are kept as a bounded internal
-- compatibility adapter: a BEFORE INSERT trigger maps them into the hidden
-- legacy project. User-facing code must write service_id directly.

CREATE OR REPLACE FUNCTION rundea_legacy_service_id(input_service_name text)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  digest text;
  resolved_id uuid;
BEGIN
  IF input_service_name IS NULL OR input_service_name = '' THEN
    RAISE EXCEPTION 'legacy service_name is required';
  END IF;

  digest := md5('rundea-service:' || input_service_name);
  resolved_id := (
    substr(digest,1,8) || '-' || substr(digest,9,4) || '-' || substr(digest,13,4) || '-' ||
    substr(digest,17,4) || '-' || substr(digest,21,12)
  )::uuid;

  INSERT INTO services(id,project_id,slug,name)
  VALUES(
    resolved_id,
    '00000000-0000-4000-8000-000000000002'::uuid,
    'legacy-' || substr(digest,1,16),
    input_service_name
  )
  ON CONFLICT DO NOTHING;

  RETURN resolved_id;
END;
$$;

CREATE OR REPLACE FUNCTION rundea_fill_legacy_service_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.service_id IS NULL THEN
    NEW.service_id := rundea_legacy_service_id(NEW.service_name);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deployments_fill_service_scope ON deployments;
CREATE TRIGGER deployments_fill_service_scope
BEFORE INSERT ON deployments
FOR EACH ROW EXECUTE FUNCTION rundea_fill_legacy_service_scope();

DROP TRIGGER IF EXISTS service_variables_fill_service_scope ON service_variables;
CREATE TRIGGER service_variables_fill_service_scope
BEFORE INSERT ON service_variables
FOR EACH ROW EXECUTE FUNCTION rundea_fill_legacy_service_scope();

DROP TRIGGER IF EXISTS service_domains_fill_service_scope ON service_domains;
CREATE TRIGGER service_domains_fill_service_scope
BEFORE INSERT ON service_domains
FOR EACH ROW EXECUTE FUNCTION rundea_fill_legacy_service_scope();

DROP TRIGGER IF EXISTS service_autodeploys_fill_service_scope ON service_autodeploys;
CREATE TRIGGER service_autodeploys_fill_service_scope
BEFORE INSERT ON service_autodeploys
FOR EACH ROW EXECUTE FUNCTION rundea_fill_legacy_service_scope();

CREATE OR REPLACE FUNCTION rundea_fill_webhook_service_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.service_id IS NULL THEN
    SELECT d.service_id INTO NEW.service_id
      FROM deployments d
     WHERE d.id=NEW.deployment_id;
  END IF;
  IF NEW.service_id IS NULL THEN
    RAISE EXCEPTION 'webhook deployment has no service_id';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS github_webhook_deployments_fill_service_scope ON github_webhook_deployments;
CREATE TRIGGER github_webhook_deployments_fill_service_scope
BEFORE INSERT ON github_webhook_deployments
FOR EACH ROW EXECUTE FUNCTION rundea_fill_webhook_service_scope();

CREATE OR REPLACE FUNCTION rundea_fill_metric_service_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.service_id IS NULL THEN
    SELECT d.service_id INTO NEW.service_id
      FROM deployments d
     WHERE d.id=NEW.deployment_id;
  END IF;
  IF NEW.service_id IS NULL THEN
    RAISE EXCEPTION 'runtime metric deployment has no service_id';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS runtime_metrics_fill_service_scope ON runtime_metrics;
CREATE TRIGGER runtime_metrics_fill_service_scope
BEFORE INSERT ON runtime_metrics
FOR EACH ROW EXECUTE FUNCTION rundea_fill_metric_service_scope();

ALTER TABLE deployments ALTER COLUMN service_id SET NOT NULL;
ALTER TABLE service_variables ALTER COLUMN service_id SET NOT NULL;
ALTER TABLE service_domains ALTER COLUMN service_id SET NOT NULL;
ALTER TABLE service_autodeploys ALTER COLUMN service_id SET NOT NULL;
ALTER TABLE github_webhook_deployments ALTER COLUMN service_id SET NOT NULL;
ALTER TABLE runtime_metrics ALTER COLUMN service_id SET NOT NULL;

-- service_id is now the variable identity. The compatibility unique index only
-- exists so the old hidden/prototype route can finish its ON CONFLICT clause.
-- Canonical services write a UUID-derived runtime key into service_name, so two
-- user projects can both own a human service named `api` without sharing state.
ALTER TABLE service_variables DROP CONSTRAINT IF EXISTS service_variables_pkey;
ALTER TABLE service_variables ADD CONSTRAINT service_variables_pkey PRIMARY KEY(service_id,key);
CREATE UNIQUE INDEX IF NOT EXISTS service_variables_runtime_key_compat_idx
  ON service_variables(service_name,key);

-- Autodeploy identity is the service UUID. Keep service_name unique only as a
-- temporary compatibility index for the prototype route's ON CONFLICT clause.
ALTER TABLE service_autodeploys DROP CONSTRAINT IF EXISTS service_autodeploys_pkey;
ALTER TABLE service_autodeploys ADD CONSTRAINT service_autodeploys_pkey PRIMARY KEY(service_id);
CREATE UNIQUE INDEX IF NOT EXISTS service_autodeploys_runtime_key_compat_idx
  ON service_autodeploys(service_name);

ALTER TABLE github_webhook_deployments DROP CONSTRAINT IF EXISTS github_webhook_deployments_pkey;
ALTER TABLE github_webhook_deployments ADD CONSTRAINT github_webhook_deployments_pkey PRIMARY KEY(delivery_id,service_id);
CREATE UNIQUE INDEX IF NOT EXISTS github_webhook_deployments_legacy_compat_idx
  ON github_webhook_deployments(delivery_id,service_name);

CREATE INDEX IF NOT EXISTS deployments_service_status_idx
  ON deployments(service_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS service_domains_service_status_idx
  ON service_domains(service_id,status,updated_at DESC);
