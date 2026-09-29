CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id text PRIMARY KEY,
  client_name text NOT NULL,
  redirect_uris jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  scope text NOT NULL,
  subject text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_oauth_refresh_tokens_expires_idx
  ON mcp_oauth_refresh_tokens(expires_at);
