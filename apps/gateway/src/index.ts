import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { accessOwner, agentFromBearer, encrypt, execute, first, randomString, rows, sha256, trustedUrl, type Agent, type AppEnv, type Connection, type Env, type Grant } from './core'
import { listTools, serveMcp } from './mcp'
import { apiKeyHeader, importSpec, saveTools, SpecError } from './openapi'
import { oauthCallback, startOAuth } from './oauth'
import { publicJwks } from './assertion'
import { discoverApp } from './discovery'
import { registerHostAuth, resourceMetadataUrl } from './hostAuth'

const app = new Hono<AppEnv>()

app.use('*', async (c, next) => {
  await next()
  if (new URL(c.req.url).pathname !== '/.well-known/agent-connect/jwks.json') c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Content-Type-Options', 'nosniff')
})

const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (new URL(c.req.url).host !== new URL(c.env.PUBLIC_BASE_URL).host) return c.text('Invalid host', 400)
  const owner = await accessOwner(c.req.raw, c.env)
  if (!owner) return c.text('Cloudflare Access authentication required', 401)
  const method = c.req.method
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = c.req.header('Origin')
    const adminOrigin = new URL(c.env.PUBLIC_BASE_URL).origin
    if (new URL(c.req.url).pathname === '/oauth/authorize') {
      // The host consent page is a plain HTML form, so require a same-origin Origin header instead of JSON.
      if (origin !== adminOrigin) return c.text('Invalid origin', 403)
    } else {
      if (origin && origin !== adminOrigin) return c.text('Invalid origin', 403)
      if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.text('JSON body required', 415)
    }
  }
  c.set('owner', owner)
  await next()
}

app.onError((error, c) => {
  console.error('Request failed:', error.name, error.message)
  return c.json({ error: 'Request failed' }, 500)
})

app.get('/health', c => c.json({ ok: true }))

app.get('/.well-known/agent-connect/jwks.json', c => {
  if (new URL(c.req.url).host !== new URL(c.env.MCP_BASE_URL).host) return c.text('Invalid host', 400)
  return c.json(publicJwks(c.env), 200, { 'Cache-Control': 'public, max-age=300' })
})

app.all('/mcp', async c => {
  if (new URL(c.req.url).host !== new URL(c.env.MCP_BASE_URL).host) return c.text('Invalid host', 400)
  const origin = c.req.header('Origin')
  if (origin && origin !== new URL(c.env.MCP_BASE_URL).origin) return c.text('Invalid origin', 403)
  const agent = await agentFromBearer(c.req.raw, c.env)
  if (!agent) return c.text('Unauthorized', 401, { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(c.env)}"` })
  return serveMcp(c.req.raw, agent, c.env)
})

app.use('/', adminAuth)
app.use('/assets/*', adminAuth)
app.use('/api/*', adminAuth)
app.use('/oauth/callback', adminAuth)
app.use('/oauth/authorize', adminAuth)

registerHostAuth(app)

app.get('/', c => c.env.ASSETS.fetch(c.req.raw))
app.get('/assets/*', c => c.env.ASSETS.fetch(c.req.raw))

app.get('/oauth/callback', c => oauthCallback(c.req.raw, c.get('owner'), c.env))

app.get('/api/overview', async c => {
  const owner = c.get('owner')
  const [agents, connections, grants, actions] = await Promise.all([
    rows<Pick<Agent, 'id' | 'name' | 'created_at' | 'revoked_at'>>(c.env,
      'SELECT id, name, created_at, revoked_at FROM agents WHERE owner_sub = $1 ORDER BY created_at DESC', [owner]),
    rows<Pick<Connection, 'id' | 'name' | 'kind' | 'auth_kind' | 'mcp_url' | 'connected_at'>>(c.env,
      'SELECT id, name, kind, auth_kind, mcp_url, connected_at FROM connections WHERE owner_sub = $1 ORDER BY created_at DESC', [owner]),
    rows<Grant>(c.env,
      'SELECT g.agent_id, g.connection_id, g.tool_name FROM grants g JOIN agents a ON a.id = g.agent_id WHERE a.owner_sub = $1', [owner]),
    rows(c.env,
      'SELECT l.id, l.agent_id, l.connection_id, l.tool_name, l.outcome, l.created_at FROM action_log l JOIN agents a ON a.id = l.agent_id WHERE a.owner_sub = $1 ORDER BY l.created_at DESC LIMIT 30', [owner]),
  ])
  return c.json({ agents, connections, grants, actions, mcp_url: `${c.env.MCP_BASE_URL}/mcp` })
})

app.post('/api/agents', async c => {
  const body = await c.req.json().catch(() => null) as { name?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 100) return c.json({ error: 'Name must be 1–100 characters' }, 400)
  const id = crypto.randomUUID()
  const token = `ac_${randomString(32)}`
  await execute(c.env, 'INSERT INTO agents (id, owner_sub, name, token_hash) VALUES ($1, $2, $3, $4)', [id, c.get('owner'), name, await sha256(token)])
  return c.json({ id, name, token, mcp_url: `${c.env.MCP_BASE_URL}/mcp` }, 201)
})

app.post('/api/agents/:id/revoke', async c => {
  const result = await execute(c.env, 'UPDATE agents SET revoked_at = now() WHERE id = $1 AND owner_sub = $2 AND revoked_at IS NULL', [c.req.param('id'), c.get('owner')])
  if (!result.rowCount) return c.json({ error: 'Agent not found' }, 404)
  return c.json({ ok: true })
})

app.post('/api/connections', async c => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return c.json({ error: 'Invalid JSON' }, 400)
  if (body.kind === 'openapi') return connectOpenApi(c, body)
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
  await execute(c.env,
    'INSERT INTO connections (id, owner_sub, name, mcp_url, authorization_url, token_url, client_id, scope) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, c.get('owner'), name, mcpUrl, authorizationUrl, tokenUrl, clientId, scope])
  return c.json({ id, authorize_url: `${c.env.PUBLIC_BASE_URL}/api/connections/${id}/authorize` }, 201)
})

/** Connect an app that has a REST API and an OpenAPI spec but no MCP server. */
async function connectOpenApi(c: Context<AppEnv>, body: Record<string, unknown>) {
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  const auth = (typeof body.auth === 'object' && body.auth !== null ? body.auth : {}) as Record<string, unknown>
  if (auth.type !== 'api_key' && auth.type !== 'oauth') return c.json({ error: 'Choose API key or OAuth' }, 400)

  let spec: Awaited<ReturnType<typeof importSpec>>
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
  if (auth.type === 'api_key') {
    const sent = apiKeyHeader(auth.header, auth.prefix)
    const value = typeof auth.value === 'string' ? auth.value.trim() : ''
    if (!sent) return c.json({ error: 'Invalid API key header or prefix' }, 400)
    if (!value || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value)) return c.json({ error: 'Enter the API key' }, 400)
    await execute(c.env,
      "INSERT INTO connections (id, owner_sub, name, kind, mcp_url, spec_url, auth_kind, auth_header, auth_prefix, access_token_ciphertext, connected_at) VALUES ($1, $2, $3, 'openapi', $4, $5, 'api_key', $6, $7, $8, now())",
      [id, owner, name, spec.baseUrl, specUrl, sent.header, sent.prefix, await encrypt(c.env, value)])
    await saveTools(id, spec.tools, c.env)
    return c.json({ id, name, base_url: spec.baseUrl, tools_imported: spec.tools.length }, 201)
  }

  const clientId = text(auth.client_id)
  const scope = text(auth.scope)
  if (!clientId || clientId.length > 2048 || scope.length > 2048) return c.json({ error: 'Invalid client ID or scope' }, 400)
  let authorizationUrl: string, tokenUrl: string
  try {
    authorizationUrl = trustedUrl(text(auth.authorization_url), c.env)
    tokenUrl = trustedUrl(text(auth.token_url), c.env)
  } catch { return c.json({ error: 'OAuth endpoints must be public HTTPS URLs' }, 400) }
  await execute(c.env,
    "INSERT INTO connections (id, owner_sub, name, kind, mcp_url, spec_url, auth_kind, authorization_url, token_url, client_id, scope) VALUES ($1, $2, $3, 'openapi', $4, $5, 'oauth', $6, $7, $8, $9)",
    [id, owner, name, spec.baseUrl, specUrl, authorizationUrl, tokenUrl, clientId, scope])
  await saveTools(id, spec.tools, c.env)
  return c.json({ id, name, base_url: spec.baseUrl, tools_imported: spec.tools.length, authorize_url: `${c.env.PUBLIC_BASE_URL}/api/connections/${id}/authorize` }, 201)
}

/** Re-import the spec. The base URL is kept, and grants for operations that no longer exist are removed. */
app.post('/api/connections/:id/refresh', async c => {
  const connection = await first<Connection>(c.env, "SELECT * FROM connections WHERE id = $1 AND owner_sub = $2 AND kind = 'openapi'", [c.req.param('id'), c.get('owner')])
  if (!connection?.spec_url) return c.json({ error: 'Connection not found' }, 404)
  let spec: Awaited<ReturnType<typeof importSpec>>
  try { spec = await importSpec(connection.spec_url, c.env, connection.mcp_url) }
  catch (error) {
    if (error instanceof SpecError) return c.json({ error: error.message }, 422)
    throw error
  }
  await saveTools(connection.id, spec.tools, c.env)
  await execute(c.env, 'DELETE FROM grants g WHERE g.connection_id = $1 AND NOT EXISTS (SELECT 1 FROM connection_tools t WHERE t.connection_id = g.connection_id AND t.tool_name = g.tool_name)', [connection.id])
  return c.json({ ok: true, tools_imported: spec.tools.length })
})

app.get('/api/connections/:id/authorize', async c => {
  const connection = await first<Connection>(c.env, 'SELECT * FROM connections WHERE id = $1 AND owner_sub = $2', [c.req.param('id'), c.get('owner')])
  if (!connection || connection.auth_kind !== 'oauth') return c.text('Connection not found', 404)
  return startOAuth(connection, c.env)
})

app.get('/api/connections/:id/tools', async c => {
  const connection = await first<Connection>(c.env, 'SELECT * FROM connections WHERE id = $1 AND owner_sub = $2', [c.req.param('id'), c.get('owner')])
  if (!connection?.access_token_ciphertext) return c.json({ error: 'App not connected' }, 409)
  try { return c.json({ tools: await listTools(connection, c.env) }) }
  catch { return c.json({ error: 'Could not reach app MCP server' }, 502) }
})

app.post('/api/connections/:id/disconnect', async c => {
  const connection = await first<Connection>(c.env, 'SELECT * FROM connections WHERE id = $1 AND owner_sub = $2', [c.req.param('id'), c.get('owner')])
  if (!connection) return c.json({ error: 'Connection not found' }, 404)
  await execute(c.env, 'DELETE FROM grants WHERE connection_id = $1', [connection.id])
  if (connection.auth_kind === 'api_key') {
    // There is no sign-in page to reconnect through, so remove the connection with its key.
    await execute(c.env, 'DELETE FROM connection_tools WHERE connection_id = $1', [connection.id])
    await execute(c.env, 'DELETE FROM connections WHERE id = $1', [connection.id])
    return c.json({ ok: true })
  }
  await execute(c.env, 'UPDATE connections SET access_token_ciphertext = NULL, refresh_token_ciphertext = NULL, token_expires_at = NULL, connected_at = NULL WHERE id = $1', [connection.id])
  return c.json({ ok: true })
})

async function grantTarget(c: Context<AppEnv>) {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body.agent_id !== 'string' || typeof body.connection_id !== 'string' || typeof body.tool_name !== 'string') return null
  const [agent, connection] = await Promise.all([
    first<Agent>(c.env, 'SELECT * FROM agents WHERE id = $1 AND owner_sub = $2 AND revoked_at IS NULL', [body.agent_id, c.get('owner')]),
    first<Connection>(c.env, 'SELECT * FROM connections WHERE id = $1 AND owner_sub = $2', [body.connection_id, c.get('owner')]),
  ])
  if (!agent || !connection?.access_token_ciphertext || body.tool_name.length > 255) return null
  return { agent, connection, toolName: body.tool_name }
}

app.post('/api/grants', async c => {
  const target = await grantTarget(c)
  if (!target) return c.json({ error: 'Agent, connection, or tool is invalid' }, 400)
  let tools: Awaited<ReturnType<typeof listTools>>
  try { tools = await listTools(target.connection, c.env) }
  catch { return c.json({ error: 'Could not verify app tool' }, 502) }
  if (!tools.some(tool => tool.name === target.toolName)) return c.json({ error: 'App tool not found' }, 404)
  await execute(c.env, 'INSERT INTO grants (agent_id, connection_id, tool_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [target.agent.id, target.connection.id, target.toolName])
  return c.json({ ok: true })
})

app.delete('/api/grants', async c => {
  const target = await grantTarget(c)
  if (!target) return c.json({ error: 'Agent, connection, or tool is invalid' }, 400)
  await execute(c.env, 'DELETE FROM grants WHERE agent_id = $1 AND connection_id = $2 AND tool_name = $3', [target.agent.id, target.connection.id, target.toolName])
  return c.json({ ok: true })
})

export default app
