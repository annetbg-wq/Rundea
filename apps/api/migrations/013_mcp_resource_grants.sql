CREATE TABLE IF NOT EXISTS mcp_resource_grants (
  issuer text NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 256),
  resource_kind text NOT NULL CHECK (resource_kind IN ('DEPLOYMENT','NODE')),
  resource_id uuid NOT NULL,
  permission text NOT NULL CHECK (permission = 'DIAGNOSTICS_READ'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject, resource_kind, resource_id, permission)
);

CREATE INDEX IF NOT EXISTS mcp_resource_grants_resource_idx
  ON mcp_resource_grants(resource_kind, resource_id);
