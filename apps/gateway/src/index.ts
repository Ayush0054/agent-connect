import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { accessOwner, agentFromBearer, execute, first, randomString, rows, sha256, trustedUrl, type Agent, type Connection, type Env, type Grant } from './core'
import { discoverTools, serveMcp } from './mcp'
import { oauthCallback, startOAuth } from './oauth'
import { publicJwks } from './assertion'
import { discoverApp } from './discovery'

type AppEnv = { Bindings: Env; Variables: { owner: string } }
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
    if (origin && origin !== new URL(c.env.PUBLIC_BASE_URL).origin) return c.text('Invalid origin', 403)
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.text('JSON body required', 415)
  }
  c.set('owner', owner)
  await next()
}

app.onError((error, c) => {
  console.error('Request failed:', error.name)
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
  if (!agent) return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer realm="agent-connect"' })
  return serveMcp(c.req.raw, agent, c.env)
})

app.use('/', adminAuth)
app.use('/assets/*', adminAuth)
app.use('/api/*', adminAuth)
app.use('/oauth/callback', adminAuth)

app.get('/', c => c.env.ASSETS.fetch(c.req.raw))
app.get('/assets/*', c => c.env.ASSETS.fetch(c.req.raw))

app.get('/oauth/callback', c => oauthCallback(c.req.raw, c.get('owner'), c.env))

app.get('/api/overview', async c => {
  const owner = c.get('owner')
  const [agents, connections, grants, actions] = await Promise.all([
    rows<Pick<Agent, 'id' | 'name' | 'created_at' | 'revoked_at'>>(c.env,
      'SELECT id, name, created_at, revoked_at FROM agents WHERE owner_sub = ? ORDER BY created_at DESC', [owner]),
    rows<Pick<Connection, 'id' | 'name' | 'mcp_url' | 'connected_at'>>(c.env,
      'SELECT id, name, mcp_url, connected_at FROM connections WHERE owner_sub = ? ORDER BY created_at DESC', [owner]),
    rows<Grant>(c.env,
      'SELECT g.agent_id, g.connection_id, g.tool_name FROM grants g JOIN agents a ON a.id = g.agent_id WHERE a.owner_sub = ?', [owner]),
    rows(c.env,
      'SELECT l.id, l.agent_id, l.connection_id, l.tool_name, l.outcome, l.created_at FROM action_log l JOIN agents a ON a.id = l.agent_id WHERE a.owner_sub = ? ORDER BY l.created_at DESC LIMIT 30', [owner]),
  ])
  return c.json({ agents, connections, grants, actions })
})

app.post('/api/agents', async c => {
  const body = await c.req.json().catch(() => null) as { name?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 100) return c.json({ error: 'Name must be 1–100 characters' }, 400)
  const id = crypto.randomUUID()
  const token = `ac_${randomString(32)}`
  await execute(c.env, 'INSERT INTO agents (id, owner_sub, name, token_hash) VALUES (?, ?, ?, ?)', [id, c.get('owner'), name, await sha256(token)])
  return c.json({ id, name, token, mcp_url: `${c.env.MCP_BASE_URL}/mcp` }, 201)
})

app.post('/api/agents/:id/revoke', async c => {
  const result = await execute(c.env, 'UPDATE agents SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND owner_sub = ? AND revoked_at IS NULL', [c.req.param('id'), c.get('owner')])
  if (!result.rowsAffected) return c.json({ error: 'Agent not found' }, 404)
  return c.json({ ok: true })
})

app.post('/api/connections', async c => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return c.json({ error: 'Invalid JSON' }, 400)
  let details = body
  const appUrl = typeof body.app_url === 'string' ? body.app_url : body.website_url
  if (typeof appUrl === 'string') {
    try {
      const manifest = await discoverApp(appUrl)
      details = {
        name: manifest.name,
        mcp_url: manifest.mcp_url,
        authorization_url: manifest.oauth.authorization_url,
        token_url: manifest.oauth.token_url,
        client_id: manifest.oauth.client_id,
        scope: manifest.oauth.scope ?? '',
      }
    } catch { return c.json({ error: 'Could not discover this app. Check its Agent Connect manifest.' }, 422) }
  }
  const name = typeof details.name === 'string' ? details.name.trim() : ''
  const clientId = typeof details.client_id === 'string' ? details.client_id.trim() : ''
  const scope = typeof details.scope === 'string' ? details.scope.trim() : ''
  if (!name || name.length > 100 || !clientId || clientId.length > 2048 || scope.length > 2048) return c.json({ error: 'Invalid name, client ID, or scope' }, 400)
  let mcpUrl: string, authorizationUrl: string, tokenUrl: string
  try {
    mcpUrl = trustedUrl(String(details.mcp_url ?? ''))
    authorizationUrl = trustedUrl(String(details.authorization_url ?? ''))
    tokenUrl = trustedUrl(String(details.token_url ?? ''))
  } catch { return c.json({ error: 'Endpoints must be public HTTPS URLs' }, 400) }
  const id = crypto.randomUUID()
  await execute(c.env,
    'INSERT INTO connections (id, owner_sub, name, mcp_url, authorization_url, token_url, client_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, c.get('owner'), name, mcpUrl, authorizationUrl, tokenUrl, clientId, scope])
  return c.json({ id, authorize_url: `${c.env.PUBLIC_BASE_URL}/api/connections/${id}/authorize` }, 201)
})

app.get('/api/connections/:id/authorize', async c => {
  const connection = await first<Connection>(c.env, 'SELECT * FROM connections WHERE id = ? AND owner_sub = ?', [c.req.param('id'), c.get('owner')])
  if (!connection) return c.text('Connection not found', 404)
  return startOAuth(connection, c.env)
})

app.get('/api/connections/:id/tools', async c => {
  const connection = await first<Connection>(c.env, 'SELECT * FROM connections WHERE id = ? AND owner_sub = ?', [c.req.param('id'), c.get('owner')])
  if (!connection?.access_token_ciphertext) return c.json({ error: 'App not connected' }, 409)
  try { return c.json({ tools: await discoverTools(connection, c.env) }) }
  catch { return c.json({ error: 'Could not reach app MCP server' }, 502) }
})

app.post('/api/connections/:id/disconnect', async c => {
  const connection = await first<Connection>(c.env, 'SELECT * FROM connections WHERE id = ? AND owner_sub = ?', [c.req.param('id'), c.get('owner')])
  if (!connection) return c.json({ error: 'Connection not found' }, 404)
  await execute(c.env, 'DELETE FROM grants WHERE connection_id = ?', [connection.id])
  await execute(c.env, 'UPDATE connections SET access_token_ciphertext = NULL, refresh_token_ciphertext = NULL, token_expires_at = NULL, connected_at = NULL WHERE id = ?', [connection.id])
  return c.json({ ok: true })
})

async function grantTarget(c: Context<AppEnv>) {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body.agent_id !== 'string' || typeof body.connection_id !== 'string' || typeof body.tool_name !== 'string') return null
  const [agent, connection] = await Promise.all([
    first<Agent>(c.env, 'SELECT * FROM agents WHERE id = ? AND owner_sub = ? AND revoked_at IS NULL', [body.agent_id, c.get('owner')]),
    first<Connection>(c.env, 'SELECT * FROM connections WHERE id = ? AND owner_sub = ?', [body.connection_id, c.get('owner')]),
  ])
  if (!agent || !connection?.access_token_ciphertext || body.tool_name.length > 255) return null
  return { agent, connection, toolName: body.tool_name }
}

app.post('/api/grants', async c => {
  const target = await grantTarget(c)
  if (!target) return c.json({ error: 'Agent, connection, or tool is invalid' }, 400)
  let tools: Awaited<ReturnType<typeof discoverTools>>
  try { tools = await discoverTools(target.connection, c.env) }
  catch { return c.json({ error: 'Could not verify app tool' }, 502) }
  if (!tools.some(tool => tool.name === target.toolName)) return c.json({ error: 'App tool not found' }, 404)
  await execute(c.env, 'INSERT IGNORE INTO grants (agent_id, connection_id, tool_name) VALUES (?, ?, ?)', [target.agent.id, target.connection.id, target.toolName])
  return c.json({ ok: true })
})

app.delete('/api/grants', async c => {
  const target = await grantTarget(c)
  if (!target) return c.json({ error: 'Agent, connection, or tool is invalid' }, 400)
  await execute(c.env, 'DELETE FROM grants WHERE agent_id = ? AND connection_id = ? AND tool_name = ?', [target.agent.id, target.connection.id, target.toolName])
  return c.json({ ok: true })
})

export default app
