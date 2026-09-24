ALTER TABLE github_webhook_deliveries
  ADD COLUMN IF NOT EXISTS build_count integer NOT NULL DEFAULT 0 CHECK (build_count >= 0);

CREATE TABLE IF NOT EXISTS github_webhook_builds (
  delivery_id text NOT NULL REFERENCES github_webhook_deliveries(delivery_id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  build_id uuid NOT NULL UNIQUE REFERENCES build_jobs(id) ON DELETE CASCADE,
  PRIMARY KEY (delivery_id, service_id)
);

CREATE INDEX IF NOT EXISTS github_webhook_builds_build_idx
  ON github_webhook_builds(build_id);
