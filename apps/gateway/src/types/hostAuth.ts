// The gateway's own OAuth server, used by MCP hosts (Claude Code, Codex, Cursor) to sign in.

/** An MCP host registered as an OAuth client. */
export type HostClient = { client_id: string; client_name: string; redirect_uris: string[]; metadataDocument: boolean }

/** Row of the `oauth_clients` table. `redirect_uris` is JSON text. */
export type StoredHostClient = { client_id: string; client_name: string; redirect_uris: string }

/** Row of the `host_auth_codes` table. */
export type AuthCode = { client_id: string; agent_id: string; redirect_uri: string; code_challenge: string; expires_at: Date }

/** Row of the `agent_tokens` table, without the token hash. */
export type AgentToken = { agent_id: string; client_id: string; expires_at: Date }

/** A validated authorization request. */
export type AuthorizeParams = { client: HostClient; redirectUri: string; state: string; codeChallenge: string }

/** The token endpoint's success response (RFC 6749 §5.1). */
export type HostTokenResponse = { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }
