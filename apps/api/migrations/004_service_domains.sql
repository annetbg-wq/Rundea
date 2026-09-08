CREATE TABLE IF NOT EXISTS service_domains (
  id uuid PRIMARY KEY,
  hostname text NOT NULL UNIQUE,
  service_name text NOT NULL,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIGURING','ACTIVE','FAILED','DELETING')),
  reconciliation_id uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);

CREATE INDEX IF NOT EXISTS service_domains_node_idx ON service_domains(node_id, hostname);
CREATE INDEX IF NOT EXISTS service_domains_service_idx ON service_domains(service_name, created_at DESC);

CREATE TABLE IF NOT EXISTS node_ingress_reconciliations (
  id uuid PRIMARY KEY,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS node_ingress_reconciliations_node_created_idx
  ON node_ingress_reconciliations(node_id, created_at DESC);
