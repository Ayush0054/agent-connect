export const SERVER_INFO = { name: 'agent-connect', version: '0.1.0' }

/** Header that tells an app which agent is calling. See `upstream/assertion.ts`. */
export const ASSERTION_HEADER = 'Agent-Connect-Assertion'

// Limits on what the gateway reads from apps.
export const MAX_SMALL_JSON_BYTES = 16_384
export const MAX_SPEC_BYTES = 2_000_000
export const MAX_RESPONSE_BYTES = 100_000
export const SPEC_FETCH_TIMEOUT_MS = 30_000
export const APP_CALL_TIMEOUT_MS = 30_000

// Limits on tools.
export const MAX_OPENAPI_TOOLS = 300
export const MAX_MCP_TOOLS = 100
export const MAX_SCHEMA_BYTES = 32_000

// Sign-in to apps.
export const OAUTH_STATE_TTL_MS = 10 * 60_000

// Sign-in of MCP hosts to the gateway.
export const HOST_SCOPE = 'mcp'
export const ACCESS_TTL_SECONDS = 3600
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600
export const CODE_TTL_SECONDS = 60
