ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS runtime_health text
    CHECK (runtime_health IS NULL OR runtime_health IN ('HEALTHY','DEGRADED','DOWN')),
  ADD COLUMN IF NOT EXISTS runtime_health_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS runtime_restart_count integer NOT NULL DEFAULT 0
    CHECK (runtime_restart_count >= 0),
  ADD COLUMN IF NOT EXISTS runtime_uptime_seconds bigint NOT NULL DEFAULT 0
    CHECK (runtime_uptime_seconds >= 0),
  ADD COLUMN IF NOT EXISTS runtime_health_error text;
