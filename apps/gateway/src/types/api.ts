// Control-plane API contract: the JSON that `apps/web` sends to and receives from `/api/*`.
// The web app imports these types, so a change here is checked on both sides.
// Every failed request answers `ErrorResponse` with a 4xx or 5xx status.
import type { Action, Agent, Grant } from './agents'
import type { Connection } from './connections'
import type { Tool } from './tools'

export type { Grant, Tool }

export type ErrorResponse = { error: string }
export type OkResponse = { ok: true }

export type AgentSummary = Pick<Agent, 'id' | 'name' | 'created_at' | 'revoked_at'>
/** `mcp_url` is the MCP endpoint, or the REST base URL for 'openapi' connections. */
export type ConnectionSummary = Pick<Connection, 'id' | 'name' | 'kind' | 'auth_kind' | 'mcp_url' | 'connected_at'>
export type ActionSummary = Omit<Action, 'outcome'> & { outcome: string }

/** GET /api/overview */
export type OverviewResponse = {
  agents: AgentSummary[]
  connections: ConnectionSummary[]
  grants: Grant[]
  /** The 30 most recent tool calls. */
  actions: ActionSummary[]
  /** The gateway MCP URL to add to an MCP host. */
  mcp_url: string
}

/** POST /api/agents */
export type CreateAgentRequest = { name: string }
/** The token is returned once and stored only as a hash. */
export type CreateAgentResponse = { id: string; name: string; token: string; mcp_url: string }

/** POST /api/connections, for an app that runs its own MCP server. Send `app_url` to read the app's manifest, or the fields by hand. */
export type ConnectMcpAppRequest =
  | { kind?: 'mcp'; app_url: string }
  | { kind?: 'mcp'; name: string; mcp_url: string; authorization_url: string; token_url: string; client_id: string; scope?: string }

/** `header` defaults to `Authorization`; `prefix` defaults to `Bearer ` for that header and to nothing for any other. */
export type ApiKeyAuth = { type: 'api_key'; header?: string; prefix?: string; value: string }
export type OAuthAuth = { type: 'oauth'; authorization_url: string; token_url: string; client_id: string; scope?: string }

/** POST /api/connections, for a REST app described by an OpenAPI 3.x spec. */
export type ConnectOpenApiRequest = {
  kind: 'openapi'
  spec_url: string
  /** Defaults to the spec's title. */
  name?: string
  /** Defaults to the spec's first server URL. */
  base_url?: string
  auth: ApiKeyAuth | OAuthAuth
}

export type ConnectRequest = ConnectMcpAppRequest | ConnectOpenApiRequest

/** `authorize_url` is present when the user still has to sign in to the app; API-key connections are connected at once. */
export type ConnectResponse = { id: string; authorize_url?: string; name?: string; base_url?: string; tools_imported?: number }

/** POST /api/connections/:id/refresh */
export type RefreshResponse = OkResponse & { tools_imported: number }

/** GET /api/connections/:id/tools */
export type ToolsResponse = { tools: Tool[] }

/** POST and DELETE /api/grants */
export type GrantRequest = Grant
