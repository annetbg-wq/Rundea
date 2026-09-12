CREATE TABLE IF NOT EXISTS project_sources (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('GITHUB')),
  provider_installation_id bigint NOT NULL CHECK (provider_installation_id > 0),
  provider_repository_id bigint NOT NULL CHECK (provider_repository_id > 0),
  repository_full_name text NOT NULL CHECK (repository_full_name ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'),
  repository_url text NOT NULL CHECK (repository_url ~ '^https://github[.]com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  visibility text NOT NULL CHECK (visibility IN ('PUBLIC','PRIVATE','INTERNAL')),
  default_branch text NOT NULL CHECK (char_length(default_branch) BETWEEN 1 AND 255),
  selected_branch text NOT NULL CHECK (char_length(selected_branch) BETWEEN 1 AND 255),
  revision_sha text NOT NULL CHECK (revision_sha ~ '^[0-9a-f]{40}$'),
  review_state text NOT NULL CHECK (review_state IN ('READY_FOR_REVIEW','NEEDS_CONFIRMATION')),
  discovery jsonb NOT NULL CHECK (jsonb_typeof(discovery) = 'object'),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_sources_repository_idx
  ON project_sources(provider, provider_installation_id, provider_repository_id);
