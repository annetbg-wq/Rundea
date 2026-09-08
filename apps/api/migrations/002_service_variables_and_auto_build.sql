ALTER TABLE deployments ALTER COLUMN dockerfile DROP NOT NULL;
ALTER TABLE deployments ALTER COLUMN dockerfile DROP DEFAULT;

CREATE TABLE IF NOT EXISTS service_variables (
  service_name text NOT NULL,
  key text NOT NULL,
  encrypted_version smallint NOT NULL DEFAULT 1 CHECK (encrypted_version = 1),
  iv text NOT NULL,
  ciphertext text NOT NULL,
  auth_tag text NOT NULL,
  is_secret boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(service_name, key),
  CHECK (key ~ '^[A-Za-z_][A-Za-z0-9_]*$')
);

CREATE INDEX IF NOT EXISTS service_variables_service_idx ON service_variables(service_name);
