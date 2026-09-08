CREATE TABLE IF NOT EXISTS runtime_metrics (
  id bigserial PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  sampled_at timestamptz NOT NULL,
  cpu_percent double precision NOT NULL CHECK (cpu_percent >= 0 AND cpu_percent <= 100000),
  memory_usage_bytes bigint NOT NULL CHECK (memory_usage_bytes >= 0),
  memory_limit_bytes bigint NOT NULL CHECK (memory_limit_bytes >= 0),
  network_rx_bytes bigint NOT NULL CHECK (network_rx_bytes >= 0),
  network_tx_bytes bigint NOT NULL CHECK (network_tx_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_metrics_deployment_sample_idx
  ON runtime_metrics(deployment_id, sampled_at DESC);

CREATE INDEX IF NOT EXISTS runtime_metrics_sample_idx
  ON runtime_metrics(sampled_at);
