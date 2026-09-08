CREATE TABLE IF NOT EXISTS node_qualifications (
  id uuid PRIMARY KEY,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  profile text NOT NULL CHECK (profile IN ('sendina-egress-v1')),
  status text NOT NULL CHECK (status IN ('RUNNING','PASSED','FAILED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS node_qualifications_node_created_idx
  ON node_qualifications(node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS node_probe_results (
  qualification_id uuid NOT NULL REFERENCES node_qualifications(id) ON DELETE CASCADE,
  name text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  ok boolean NOT NULL,
  latency_ms integer,
  error text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (qualification_id, name)
);
