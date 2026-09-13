CREATE TABLE IF NOT EXISTS project_provider_connections (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider_id text NOT NULL CHECK (provider_id ~ '^[a-z][a-z0-9-]{1,63}$'),
  state text NOT NULL CHECK (state IN (
    'PROVIDER_SELECTED','AUTH_REQUIRED','DISCOVERING','NEEDS_USER_STEP','VERIFYING_USER_STEP','DISCOVERING_CONTINUED','READY',
    'AUTH_FAILED','INSUFFICIENT_PERMISSION','UNSUPPORTED_CONFIGURATION','PROVIDER_UNAVAILABLE','VERIFICATION_FAILED'
  )),
  credential_kind text CHECK (credential_kind IS NULL OR credential_kind IN ('API_TOKEN')),
  credential_encrypted jsonb CHECK (credential_encrypted IS NULL OR jsonb_typeof(credential_encrypted) = 'object'),
  account_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(account_context) = 'object'),
  discovery jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(discovery) = 'object'),
  selected_compute_id text CHECK (selected_compute_id IS NULL OR char_length(selected_compute_id) BETWEEN 1 AND 255),
  guidance_step_id text CHECK (guidance_step_id IS NULL OR char_length(guidance_step_id) BETWEEN 1 AND 128),
  last_error_code text CHECK (last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 80),
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, provider_id)
);

CREATE INDEX IF NOT EXISTS project_provider_connections_project_idx
  ON project_provider_connections(project_id, updated_at DESC);
