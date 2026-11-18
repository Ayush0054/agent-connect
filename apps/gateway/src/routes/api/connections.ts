import { Hono, type Context } from 'hono'
import { listTools } from '../../mcp/tools'
import { deleteConnectionTools, replaceConnectionTools } from '../../stores/connectionTools'
import { clearConnectionTokens, deleteConnection, getConnection, insertApiKeyConnection, insertMcpConnection, insertOpenApiOAuthConnection } from '../../stores/connections'
import { deleteGrantsForConnection, deleteGrantsForMissingTools } from '../../stores/grants'
import type { ConnectResponse, OkResponse, RefreshResponse, ToolsResponse } from '../../types/api'
import type { AppEnv } from '../../types/env'
import type { ImportedSpec } from '../../types/tools'
import { startOAuth } from '../../upstream/appOAuth'
import { discoverApp } from '../../upstream/discovery'
import { importSpec, SpecError } from '../../upstream/openapiSpec'
import { apiKeyHeader } from '../../upstream/restApp'
import { encrypt } from '../../utils/crypto'
import { trustedUrl } from '../../utils/urls'

export const connectionRoutes = new Hono<AppEnv>()

const authorizeUrl = (c: Context<AppEnv>, id: string) => `${c.env.PUBLIC_BASE_URL}/api/connections/${id}/authorize`

connectionRoutes.post('/', async c => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return c.json({ error: 'Invalid JSON' }, 400)
  if (body.kind === 'openapi') return connectOpenApi(c, body)
  return connectMcpApp(c, body)
})

/** Connect an app that runs its own MCP server, from its manifest (`app_url`) or from fields entered by hand. */
async function connectMcpApp(c: Context<AppEnv>, body: Record<string, unknown>) {
  let details = body
  const appUrl = typeof body.app_url === 'string' ? body.app_url : body.website_url
  if (typeof appUrl === 'string') {
    try {
      const manifest = await discoverApp(appUrl, c.env)
      details = {
        name: manifest.name,
        mcp_url: manifest.mcp_url,
        authorization_url: manifest.oauth.authorization_url,
        token_url: manifest.oauth.token_url,
        client_id: manifest.oauth.client_id,
        scope: manifest.oauth.scope ?? '',
      }
    } catch (error) {
      console.warn('App discovery failed:', error instanceof Error ? error.message : error)
      return c.json({ error: 'Could not discover this app. Check its Agent Connect manifest.' }, 422)
    }
  }
  const name = typeof details.name === 'string' ? details.name.trim() : ''
  const clientId = typeof details.client_id === 'string' ? details.client_id.trim() : ''
  const scope = typeof details.scope === 'string' ? details.scope.trim() : ''
  if (!name || name.length > 100 || !clientId || clientId.length > 2048 || scope.length > 2048) return c.json({ error: 'Invalid name, client ID, or scope' }, 400)
  let mcpUrl: string, authorizationUrl: string, tokenUrl: string
  try {
    mcpUrl = trustedUrl(String(details.mcp_url ?? ''), c.env)
    authorizationUrl = trustedUrl(String(details.authorization_url ?? ''), c.env)
    tokenUrl = trustedUrl(String(details.token_url ?? ''), c.env)
  } catch { return c.json({ error: 'Endpoints must be public HTTPS URLs' }, 400) }
  const id = crypto.randomUUID()
  await insertMcpConnection(c.env, { id, owner: c.get('owner'), name, mcpUrl, authorizationUrl, tokenUrl, clientId, scope })
  return c.json({ id, authorize_url: authorizeUrl(c, id) } satisfies ConnectResponse, 201)
}

/** Connect an app that has a REST API and an OpenAPI spec but no MCP server. */
async function connectOpenApi(c: Context<AppEnv>, body: Record<string, unknown>) {
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  const auth = (typeof body.auth === 'object' && body.auth !== null ? body.auth : {}) as Record<string, unknown>
  if (auth.type !== 'api_key' && auth.type !== 'oauth') return c.json({ error: 'Choose API key or OAuth' }, 400)

  let spec: ImportedSpec
  try { spec = await importSpec(text(body.spec_url), c.env, text(body.base_url) || undefined) }
  catch (error) {
    if (error instanceof SpecError) return c.json({ error: error.message }, 422)
    throw error
  }
  const name = text(body.name) || spec.title || new URL(spec.baseUrl).hostname
  if (name.length > 100) return c.json({ error: 'Name must be at most 100 characters' }, 400)

  const id = crypto.randomUUID()
  const owner = c.get('owner')
  const specUrl = trustedUrl(text(body.spec_url), c.env)
  const imported = { id, name, base_url: spec.baseUrl, tools_imported: spec.tools.length }

  if (auth.type === 'api_key') {
    const sent = apiKeyHeader(auth.header, auth.prefix)
    const value = typeof auth.value === 'string' ? auth.value.trim() : ''
    if (!sent) return c.json({ error: 'Invalid API key header or prefix' }, 400)
    if (!value || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value)) return c.json({ error: 'Enter the API key' }, 400)
    await insertApiKeyConnection(c.env, { id, owner, name, baseUrl: spec.baseUrl, specUrl, header: sent.header, prefix: sent.prefix, keyCiphertext: await encrypt(c.env, value) })
    await replaceConnectionTools(c.env, id, spec.tools)
    return c.json(imported satisfies ConnectResponse, 201)
  }

  const clientId = text(auth.client_id)
  const scope = text(auth.scope)
  if (!clientId || clientId.length > 2048 || scope.length > 2048) return c.json({ error: 'Invalid client ID or scope' }, 400)
  let authorizationUrl: string, tokenUrl: string
  try {
    authorizationUrl = trustedUrl(text(auth.authorization_url), c.env)
    tokenUrl = trustedUrl(text(auth.token_url), c.env)
  } catch { return c.json({ error: 'OAuth endpoints must be public HTTPS URLs' }, 400) }
  await insertOpenApiOAuthConnection(c.env, { id, owner, name, baseUrl: spec.baseUrl, specUrl, authorizationUrl, tokenUrl, clientId, scope })
  await replaceConnectionTools(c.env, id, spec.tools)
  return c.json({ ...imported, authorize_url: authorizeUrl(c, id) } satisfies ConnectResponse, 201)
}

/** Re-import the spec. The base URL is kept, and grants for operations that no longer exist are removed. */
connectionRoutes.post('/:id/refresh', async c => {
  const connection = await getConnection(c.env, c.req.param('id'), c.get('owner'))
  if (connection?.kind !== 'openapi' || !connection.spec_url) return c.json({ error: 'Connection not found' }, 404)
  let spec: ImportedSpec
  try { spec = await importSpec(connection.spec_url, c.env, connection.mcp_url) }
  catch (error) {
    if (error instanceof SpecError) return c.json({ error: error.message }, 422)
    throw error
  }
  await replaceConnectionTools(c.env, connection.id, spec.tools)
  await deleteGrantsForMissingTools(c.env, connection.id)
  return c.json({ ok: true, tools_imported: spec.tools.length } satisfies RefreshResponse)
})

/** Send the user to the app's sign-in page. */
connectionRoutes.get('/:id/authorize', async c => {
  const connection = await getConnection(c.env, c.req.param('id'), c.get('owner'))
  if (!connection || connection.auth_kind !== 'oauth') return c.text('Connection not found', 404)
  return startOAuth(connection, c.env)
})

connectionRoutes.get('/:id/tools', async c => {
  const connection = await getConnection(c.env, c.req.param('id'), c.get('owner'))
  if (!connection?.access_token_ciphertext) return c.json({ error: 'App not connected' }, 409)
  try { return c.json({ tools: await listTools(connection, c.env) } satisfies ToolsResponse) }
  catch { return c.json({ error: 'Could not reach app MCP server' }, 502) }
})

connectionRoutes.post('/:id/disconnect', async c => {
  const connection = await getConnection(c.env, c.req.param('id'), c.get('owner'))
  if (!connection) return c.json({ error: 'Connection not found' }, 404)
  await deleteGrantsForConnection(c.env, connection.id)
  if (connection.auth_kind === 'api_key') {
    // There is no sign-in page to reconnect through, so remove the connection with its key.
    await deleteConnectionTools(c.env, connection.id)
    await deleteConnection(c.env, connection.id)
  } else {
    await clearConnectionTokens(c.env, connection.id)
  }
  return c.json({ ok: true } satisfies OkResponse)
})
