ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS disk_total_bytes bigint,
  ADD COLUMN IF NOT EXISTS disk_available_bytes bigint,
  ADD COLUMN IF NOT EXISTS disk_sampled_at timestamptz;

DO $$
BEGIN
  ALTER TABLE nodes ADD CONSTRAINT nodes_disk_metrics_valid CHECK (
    (disk_total_bytes IS NULL AND disk_available_bytes IS NULL AND disk_sampled_at IS NULL)
    OR (
      disk_total_bytes > 0
      AND disk_available_bytes >= 0
      AND disk_available_bytes <= disk_total_bytes
      AND disk_sampled_at IS NOT NULL
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
