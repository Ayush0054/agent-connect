// Rows of the `connections` and `oauth_states` tables, and the manifest an MCP app publishes.

/** `mcp`: the app runs its own MCP server. `openapi`: the gateway builds the tools from the app's OpenAPI spec. */
export type ConnectionKind = 'mcp' | 'openapi'

/** How the gateway signs in to the app. */
export type AuthKind = 'oauth' | 'api_key'

export type Connection = {
  id: string
  owner_sub: string
  name: string
  kind: ConnectionKind
  /** The app's MCP endpoint, or the REST API base URL for 'openapi' connections. */
  mcp_url: string
  spec_url: string | null
  auth_kind: AuthKind
  auth_header: string | null
  auth_prefix: string | null
  authorization_url: string
  token_url: string
  client_id: string
  scope: string
  /** The OAuth access token or the API key, encrypted. Null until the app is connected. */
  access_token_ciphertext: string | null
  refresh_token_ciphertext: string | null
  token_expires_at: Date | null
  connected_at: string | null
}

/** A pending sign-in to an app, created when the user is sent to the app's authorization page. */
export type OAuthState = { owner_sub: string; connection_id: string; verifier_ciphertext: string; expires_at: Date }

/** The app's answer from its OAuth token endpoint. Untrusted until checked. */
export type TokenResponse = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown; error?: unknown }

/** `/.well-known/agent-connect.json`, served by apps that use the server SDK. */
export type AppManifest = {
  version: 1
  name: string
  mcp_url: string
  oauth: { authorization_url: string; token_url: string; client_id: string; scope?: string }
}
