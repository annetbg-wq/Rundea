-- RUNDEA DOGFOOD GATE v1: introduce stable Service identity without breaking
-- legacy service_name callers during the cutover. A later cutover migration will
-- make service_id authoritative/NOT NULL and remove legacy uniqueness.

CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE(project_id, slug),
  CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  CHECK (char_length(name) BETWEEN 1 AND 80),
  CHECK ((status='ARCHIVED' AND archived_at IS NOT NULL) OR (status='ACTIVE' AND archived_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS services_project_name_ci_idx
  ON services(project_id, lower(name));
CREATE INDEX IF NOT EXISTS services_project_created_idx
  ON services(project_id, created_at ASC, id ASC);

-- Existing prototype-era rows have no project identity. Preserve them under a
-- hidden internal workspace/project that has no membership, instead of
-- incorrectly assigning them to an arbitrary user project. Normal user flows
-- never create or target this migration bucket.
INSERT INTO workspaces(id,slug,name)
VALUES('00000000-0000-4000-8000-000000000001','rundea-internal-legacy-7b4d91','Rundea legacy import')
ON CONFLICT (id) DO NOTHING;

INSERT INTO projects(id,workspace_id,slug,name)
VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','rundea-internal-legacy-7b4d91','Legacy imported services')
ON CONFLICT (id) DO NOTHING;

WITH legacy_names AS (
  SELECT service_name FROM deployments
  UNION SELECT service_name FROM service_variables
  UNION SELECT service_name FROM service_domains
  UNION SELECT service_name FROM service_autodeploys
  UNION SELECT service_name FROM github_webhook_deployments
), normalized AS (
  SELECT service_name,
         md5('rundea-service:' || service_name) AS digest
    FROM legacy_names
   WHERE service_name IS NOT NULL AND service_name <> ''
)
INSERT INTO services(id,project_id,slug,name)
SELECT (
         substr(digest,1,8) || '-' || substr(digest,9,4) || '-' || substr(digest,13,4) || '-' ||
         substr(digest,17,4) || '-' || substr(digest,21,12)
       )::uuid,
       '00000000-0000-4000-8000-000000000002'::uuid,
       'legacy-' || substr(digest,1,16),
       service_name
  FROM normalized
ON CONFLICT DO NOTHING;

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES services(id) ON DELETE RESTRICT;
ALTER TABLE service_variables ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES services(id) ON DELETE CASCADE;
ALTER TABLE service_domains ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES services(id) ON DELETE CASCADE;
ALTER TABLE service_autodeploys ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES services(id) ON DELETE CASCADE;
ALTER TABLE github_webhook_deployments ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES services(id) ON DELETE CASCADE;
ALTER TABLE runtime_metrics ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES services(id) ON DELETE CASCADE;

UPDATE deployments d
   SET service_id=s.id
  FROM services s
 WHERE d.service_id IS NULL
   AND s.project_id='00000000-0000-4000-8000-000000000002'::uuid
   AND s.name=d.service_name;

UPDATE service_variables v
   SET service_id=s.id
  FROM services s
 WHERE v.service_id IS NULL
   AND s.project_id='00000000-0000-4000-8000-000000000002'::uuid
   AND s.name=v.service_name;

UPDATE service_domains d
   SET service_id=s.id
  FROM services s
 WHERE d.service_id IS NULL
   AND s.project_id='00000000-0000-4000-8000-000000000002'::uuid
   AND s.name=d.service_name;

UPDATE service_autodeploys a
   SET service_id=s.id
  FROM services s
 WHERE a.service_id IS NULL
   AND s.project_id='00000000-0000-4000-8000-000000000002'::uuid
   AND s.name=a.service_name;

UPDATE github_webhook_deployments h
   SET service_id=s.id
  FROM services s
 WHERE h.service_id IS NULL
   AND s.project_id='00000000-0000-4000-8000-000000000002'::uuid
   AND s.name=h.service_name;

UPDATE runtime_metrics m
   SET service_id=d.service_id
  FROM deployments d
 WHERE m.service_id IS NULL
   AND d.id=m.deployment_id
   AND d.service_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS deployments_service_created_idx
  ON deployments(service_id, created_at DESC) WHERE service_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_variables_service_id_idx
  ON service_variables(service_id, key) WHERE service_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_domains_service_id_idx
  ON service_domains(service_id, created_at DESC) WHERE service_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_autodeploys_service_id_idx
  ON service_autodeploys(service_id) WHERE service_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS github_webhook_deployments_service_id_idx
  ON github_webhook_deployments(service_id) WHERE service_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runtime_metrics_service_sample_idx
  ON runtime_metrics(service_id, sampled_at DESC) WHERE service_id IS NOT NULL;
