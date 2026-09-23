CREATE TABLE IF NOT EXISTS build_jobs (
  id uuid PRIMARY KEY,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_repository text NOT NULL CHECK (source_repository ~ '^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\\.git)?$'),
  source_commit_sha char(40) NOT NULL CHECK (source_commit_sha ~ '^[0-9a-f]{40}$'),
  dockerfile text,
  build_args jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(build_args)='object'),
  registry_repository text NOT NULL CHECK (char_length(registry_repository) BETWEEN 3 AND 512),
  status text NOT NULL CHECK (status IN ('QUEUED','CLAIMED','BUILDING','PUSHED','FAILED','CANCELLED')),
  worker_id text,
  lease_until timestamptz,
  artifact_image_ref text,
  image_id text,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (dockerfile IS NULL OR char_length(dockerfile) BETWEEN 1 AND 600),
  CHECK (worker_id IS NULL OR char_length(worker_id) BETWEEN 1 AND 200),
  CHECK (artifact_image_ref IS NULL OR artifact_image_ref ~ '@sha256:[0-9a-f]{64}$'),
  CHECK (image_id IS NULL OR image_id ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS build_jobs_service_created_idx
  ON build_jobs(service_id, created_at DESC);
CREATE INDEX IF NOT EXISTS build_jobs_claim_idx
  ON build_jobs(status, lease_until, created_at ASC);

CREATE TABLE IF NOT EXISTS build_events (
  id bigserial PRIMARY KEY,
  build_id uuid NOT NULL REFERENCES build_jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('STATUS','LOG')),
  status text,
  stream text,
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS build_events_build_idx
  ON build_events(build_id, id);
