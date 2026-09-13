ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS agent_version text,
  ADD COLUMN IF NOT EXISTS agent_build_sha text,
  ADD COLUMN IF NOT EXISTS agent_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS compatibility_error text,
  ADD COLUMN IF NOT EXISTS agent_connected_at timestamptz;

ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_agent_capabilities_array_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_agent_capabilities_array_check
  CHECK (jsonb_typeof(agent_capabilities) = 'array');
