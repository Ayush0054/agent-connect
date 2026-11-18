// /.well-known: public metadata, served on the MCP origin.
import { Hono, type Context } from 'hono'
import { HOST_SCOPE } from '../constants'
import { issuer, mcpResource } from '../hostAuth/authorize'
import type { AppEnv } from '../types/env'
import { publicJwks } from '../upstream/assertion'

export const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version' }
export const onMcpHost = (c: Context<AppEnv>) => new URL(c.req.url).host === new URL(c.env.MCP_BASE_URL).host

export const wellKnownRoutes = new Hono<AppEnv>()

/** Public keys apps use to verify the agent assertion. */
wellKnownRoutes.get('/agent-connect/jwks.json', c => {
  if (!onMcpHost(c)) return c.text('Invalid host', 400)
  return c.json(publicJwks(c.env), 200, { 'Cache-Control': 'public, max-age=300' })
})

/** RFC 9728: tells an MCP host which authorization server protects /mcp. */
const resourceMetadata = (c: Context<AppEnv>) => {
  if (!onMcpHost(c)) return c.text('Not found', 404)
  return c.json({
    resource: mcpResource(c.env),
    authorization_servers: [issuer(c.env)],
    scopes_supported: [HOST_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Agent Connect',
  }, 200, cors)
}
wellKnownRoutes.get('/oauth-protected-resource', resourceMetadata)
wellKnownRoutes.get('/oauth-protected-resource/mcp', resourceMetadata)

/** RFC 8414: where an MCP host registers, sends the user, and gets tokens. */
wellKnownRoutes.get('/oauth-authorization-server', c => {
  if (!onMcpHost(c)) return c.text('Not found', 404)
  return c.json({
    issuer: issuer(c.env),
    authorization_endpoint: `${new URL(c.env.PUBLIC_BASE_URL).origin}/oauth/authorize`,
    token_endpoint: `${issuer(c.env)}/oauth/token`,
    registration_endpoint: `${issuer(c.env)}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [HOST_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }, 200, cors)
})

for (const path of ['/oauth-protected-resource', '/oauth-protected-resource/mcp', '/oauth-authorization-server']) {
  wellKnownRoutes.options(path, c => onMcpHost(c) ? c.body(null, 204, cors) : c.text('Not found', 404))
}
