ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS public_addresses text[] NOT NULL DEFAULT ARRAY[]::text[];
