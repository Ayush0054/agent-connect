-- Adds OpenAPI (REST) connections to a database created before this change.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'mcp';
ALTER TABLE connections ADD COLUMN IF NOT EXISTS spec_url VARCHAR(2048);
ALTER TABLE connections ADD COLUMN IF NOT EXISTS auth_kind VARCHAR(16) NOT NULL DEFAULT 'oauth';
ALTER TABLE connections ADD COLUMN IF NOT EXISTS auth_header VARCHAR(255);
ALTER TABLE connections ADD COLUMN IF NOT EXISTS auth_prefix VARCHAR(64);
ALTER TABLE connections ALTER COLUMN authorization_url SET DEFAULT '';
ALTER TABLE connections ALTER COLUMN token_url SET DEFAULT '';
ALTER TABLE connections ALTER COLUMN client_id SET DEFAULT '';

CREATE TABLE IF NOT EXISTS connection_tools (
  connection_id VARCHAR(64) NOT NULL,
  tool_name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  method VARCHAR(16) NOT NULL,
  path VARCHAR(2048) NOT NULL,
  input_schema TEXT NOT NULL,
  params TEXT NOT NULL,
  PRIMARY KEY (connection_id, tool_name)
);
