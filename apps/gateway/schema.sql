CREATE TABLE agents (
  id VARCHAR(64) PRIMARY KEY,
  owner_sub VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  -- Static token for manually configured hosts; NULL for agents created through host OAuth.
  token_hash CHAR(64) NULL UNIQUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at DATETIME(3) NULL,
  INDEX agents_owner (owner_sub)
);

CREATE TABLE connections (
  id VARCHAR(64) PRIMARY KEY,
  owner_sub VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  mcp_url VARCHAR(2048) NOT NULL,
  authorization_url VARCHAR(2048) NOT NULL,
  token_url VARCHAR(2048) NOT NULL,
  client_id VARCHAR(2048) NOT NULL,
  scope VARCHAR(2048) NOT NULL DEFAULT '',
  access_token_ciphertext TEXT NULL,
  refresh_token_ciphertext TEXT NULL,
  token_expires_at DATETIME(3) NULL,
  connected_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX connections_owner (owner_sub)
);

CREATE TABLE grants (
  agent_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  tool_name VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (agent_id, connection_id, tool_name),
  INDEX grants_connection (connection_id)
);

CREATE TABLE oauth_states (
  state_hash CHAR(64) PRIMARY KEY,
  owner_sub VARCHAR(255) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE action_log (
  id VARCHAR(64) PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  tool_name VARCHAR(255) NOT NULL,
  outcome VARCHAR(32) NOT NULL,
  error_code VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX action_owner (agent_id, created_at)
);

-- Host OAuth: MCP hosts (Claude Code, Codex, ...) authorize against the gateway itself.
CREATE TABLE oauth_clients (
  client_id VARCHAR(64) PRIMARY KEY,
  client_name VARCHAR(255) NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE host_auth_codes (
  code_hash CHAR(64) PRIMARY KEY,
  client_id VARCHAR(2048) NOT NULL,
  agent_id VARCHAR(64) NOT NULL,
  redirect_uri VARCHAR(2048) NOT NULL,
  code_challenge VARCHAR(128) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE agent_tokens (
  token_hash CHAR(64) PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL,
  client_id VARCHAR(2048) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX agent_tokens_agent (agent_id)
);
