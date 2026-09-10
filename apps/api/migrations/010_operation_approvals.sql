CREATE TABLE IF NOT EXISTS operation_approvals (
  ref_hash text PRIMARY KEY CHECK (ref_hash ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('SESSION_POLICY','EXPLICIT')),
  approved_by text NOT NULL DEFAULT 'HUMAN' CHECK (approved_by = 'HUMAN'),
  operation_name text NULL CHECK (operation_name IS NULL OR char_length(operation_name) BETWEEN 1 AND 128),
  resource_id text NULL CHECK (resource_id IS NULL OR char_length(resource_id) BETWEEN 1 AND 256),
  operation_names text[] NULL,
  resource_ids text[] NULL,
  allow_sensitive boolean NOT NULL DEFAULT false,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  max_uses integer NULL CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 1000),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  last_used_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at),
  CHECK (max_uses IS NULL OR use_count <= max_uses),
  CHECK (
    (kind = 'EXPLICIT'
      AND operation_name IS NOT NULL
      AND resource_id IS NOT NULL
      AND operation_names IS NULL
      AND resource_ids IS NULL
      AND allow_sensitive = false
      AND max_uses = 1)
    OR
    (kind = 'SESSION_POLICY'
      AND operation_name IS NULL
      AND resource_id IS NULL
      AND operation_names IS NOT NULL
      AND resource_ids IS NOT NULL
      AND cardinality(operation_names) BETWEEN 1 AND 64
      AND cardinality(resource_ids) BETWEEN 1 AND 64)
  )
);

CREATE INDEX IF NOT EXISTS operation_approvals_expires_at_idx
  ON operation_approvals(expires_at)
  WHERE revoked_at IS NULL;
