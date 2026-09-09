ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS bootstrap_token_hash char(64),
  ADD COLUMN IF NOT EXISTS bootstrap_expires_at timestamptz;

-- Existing nodes already hold active Agent credentials in token_hash. New node
-- creation continues to use the existing INSERT contract, but this trigger
-- moves the returned token into a bootstrap-only slot and replaces token_hash
-- with an impossible placeholder until the one-time exchange succeeds.
CREATE OR REPLACE FUNCTION rundea_initialize_node_bootstrap_credential()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.bootstrap_token_hash IS NULL THEN
    NEW.bootstrap_token_hash := NEW.token_hash;
    NEW.bootstrap_expires_at := now() + interval '30 minutes';
    NEW.token_hash := repeat('0', 64);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rundea_nodes_bootstrap_credential ON nodes;
CREATE TRIGGER rundea_nodes_bootstrap_credential
BEFORE INSERT ON nodes
FOR EACH ROW
EXECUTE FUNCTION rundea_initialize_node_bootstrap_credential();
