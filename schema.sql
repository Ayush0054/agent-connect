CREATE TABLE agents (
  id VARCHAR(64) PRIMARY KEY,
  owner_sub VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
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
