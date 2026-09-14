-- RUNDEA DOGFOOD GATE v1: confirmed repository discovery becomes stable
-- per-service deployment configuration instead of being re-guessed per deploy.

CREATE TABLE IF NOT EXISTS service_source_configs (
  service_id uuid PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_full_name text NOT NULL CHECK (repository_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  selected_branch text NOT NULL CHECK (char_length(selected_branch) BETWEEN 1 AND 255),
  revision_sha text NOT NULL CHECK (revision_sha ~ '^[0-9a-f]{40}$'),
  source_path text NOT NULL CHECK (char_length(source_path) BETWEEN 1 AND 600),
  dockerfile text,
  container_port integer NOT NULL CHECK (container_port BETWEEN 1 AND 65535),
  healthcheck_path text NOT NULL DEFAULT '' CHECK (char_length(healthcheck_path) <= 512),
  build_variable_names jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(build_variable_names)='array'),
  runtime_variable_names jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(runtime_variable_names)='array'),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, source_path),
  CHECK (dockerfile IS NULL OR (char_length(dockerfile) BETWEEN 1 AND 600))
);

CREATE INDEX IF NOT EXISTS service_source_configs_project_idx
  ON service_source_configs(project_id, confirmed_at ASC, service_id ASC);
