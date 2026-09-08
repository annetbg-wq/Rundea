CREATE TABLE IF NOT EXISTS deployment_runtime_metrics (
  id bigserial PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  cpu_percent double precision NOT NULL CHECK (cpu_percent >= 0 AND cpu_percent <= 100000),
  memory_bytes bigint NOT NULL CHECK (memory_bytes >= 0),
  memory_limit_bytes bigint NOT NULL CHECK (memory_limit_bytes >= 0),
  network_rx_bytes bigint NOT NULL CHECK (network_rx_bytes >= 0),
  network_tx_bytes bigint NOT NULL CHECK (network_tx_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS deployment_runtime_metrics_deployment_time_idx
  ON deployment_runtime_metrics(deployment_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS deployment_runtime_metrics_observed_at_idx
  ON deployment_runtime_metrics(observed_at);
