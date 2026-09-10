CREATE TABLE IF NOT EXISTS operation_audit (
  correlation_id uuid PRIMARY KEY,
  operation_name text NOT NULL CHECK (char_length(operation_name) BETWEEN 1 AND 128),
  client text NOT NULL CHECK (client IN ('WEB','API','MCP','RUNDEA_AI','CLI')),
  resource_id text NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 256),
  effective_risk_class text NOT NULL CHECK (effective_risk_class IN ('READ_ONLY','SAFE_WRITE','SENSITIVE_WRITE','DESTRUCTIVE')),
  approval_ref text NULL CHECK (approval_ref IS NULL OR char_length(approval_ref) BETWEEN 1 AND 128),
  state text NOT NULL CHECK (state IN ('DENIED','AUTHORIZED','SUCCEEDED','FAILED')),
  error_code text NULL CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 64),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CHECK (
    (state = 'AUTHORIZED' AND completed_at IS NULL)
    OR (state IN ('DENIED','SUCCEEDED','FAILED') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS operation_audit_started_at_idx
  ON operation_audit(started_at DESC);

CREATE INDEX IF NOT EXISTS operation_audit_resource_idx
  ON operation_audit(resource_id, started_at DESC);
