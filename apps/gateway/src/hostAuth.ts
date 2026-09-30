// OAuth authorization server for MCP hosts (Claude Code, Codex, Cursor, SDK clients).
// A host adds the gateway's MCP URL, receives a 401 pointing at our metadata,
// registers (DCR or a client ID metadata document), and sends the user to a
// consent page where they pick or create an agent and choose its tools.
// The resulting tokens are bound to that agent; revoking the agent revokes them.
import type { Context, Hono } from 'hono'
import { html } from 'hono/html'
import { dateSql, execute, first, pkceChallenge, randomString, rows, sha256, trustedUrl, type Agent, type AppEnv, type Connection, type Env } from './core'
import { readSmallJson } from './discovery'
import { discoverTools } from './mcp'

const ACCESS_TTL_SECONDS = 3600
const REFRESH_TTL_SECONDS = 30 * 24 * 3600
const CODE_TTL_SECONDS = 60
const SCOPE = 'mcp'

type Client = { client_id: string; client_name: string; redirect_uris: string[]; metadataDocument: boolean }
type AuthCode = { client_id: string; agent_id: string; redirect_uri: string; code_challenge: string; expires_at: string }
type AgentToken = { agent_id: string; client_id: string; expires_at: string }

export const issuer = (env: Env) => new URL(env.MCP_BASE_URL).origin
export const mcpResource = (env: Env) => `${issuer(env)}/mcp`
export const resourceMetadataUrl = (env: Env) => `${issuer(env)}/.well-known/oauth-protected-resource/mcp`

const onMcpHost = (c: Context<AppEnv>) => new URL(c.req.url).host === new URL(c.env.MCP_BASE_URL).host
const expired = (value: string) => Date.parse(value.replace(' ', 'T') + 'Z') <= Date.now()
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version' }

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
}

/** https, http on loopback (RFC 8252 native apps), or a private-use scheme such as cursor://. */
function allowedRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.hash || url.username || url.password) return false
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') return isLoopback(url)
  return !['javascript:', 'data:', 'file:', 'blob:', 'vbscript:', 'about:'].includes(url.protocol)
}

/** Exact match, except loopback redirects may use any port (RFC 8252 §7.3). */
function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true
  let wanted: URL
  try { wanted = new URL(requested) } catch { return false }
  if (wanted.protocol !== 'http:' || !isLoopback(wanted)) return false
  return registered.some(value => {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === wanted.hostname && url.pathname === wanted.pathname && url.search === wanted.search
  })
}

async function resolveClient(clientId: string, env: Env): Promise<Client | null> {
  if (clientId.startsWith('https://')) {
    // Client ID metadata document: the client_id is a URL serving the client's metadata.
    try {
      const response = await fetch(trustedUrl(clientId, env), { headers: { Accept: 'application/json' }, redirect: 'manual' })
      if (!response.ok) return null
      const doc = await readSmallJson(response) as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown }
      if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every(allowedRedirect)) return null
      const name = typeof doc.client_name === 'string' && doc.client_name.trim() ? doc.client_name.trim().slice(0, 100) : new URL(clientId).hostname
      return { client_id: clientId, client_name: name, redirect_uris: doc.redirect_uris, metadataDocument: true }
    } catch { return null }
  }
  const row = await first<{ client_id: string; client_name: string; redirect_uris: string }>(env, 'SELECT * FROM oauth_clients WHERE client_id = ?', [clientId])
  return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[], metadataDocument: false } : null
}

async function issueTokens(env: Env, agentId: string, clientId: string) {
  const access = `ac_${randomString(32)}`
  const refresh = `acr_${randomString(32)}`
  const now = Date.now()
  await execute(env, 'INSERT INTO agent_tokens (token_hash, agent_id, client_id, kind, expires_at) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)', [
    await sha256(access), agentId, clientId, 'access', dateSql(new Date(now + ACCESS_TTL_SECONDS * 1000)),
    await sha256(refresh), agentId, clientId, 'refresh', dateSql(new Date(now + REFRESH_TTL_SECONDS * 1000)),
  ])
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: SCOPE }
}

type AuthorizeParams = { client: Client; redirectUri: string; state: string; codeChallenge: string }

/** Validates an authorization request. Errors before the redirect URI is trusted are shown, not redirected. */
async function authorizeParams(params: Record<string, string | undefined>, env: Env): Promise<{ ok: AuthorizeParams } | { page: string } | { redirect: string }> {
  const client = params.client_id ? await resolveClient(params.client_id, env) : null
  if (!client) return { page: 'Unknown client. The MCP host must register with Agent Connect first.' }
  const redirectUri = params.redirect_uri ?? ''
  if (!redirectMatches(client.redirect_uris, redirectUri)) return { page: 'This redirect URI is not registered for the client.' }
  const fail = (error: string) => {
    const target = new URL(redirectUri)
    target.searchParams.set('error', error)
    if (params.state) target.searchParams.set('state', params.state)
    target.searchParams.set('iss', issuer(env))
    return { redirect: target.toString() }
  }
  if (params.response_type !== 'code') return fail('unsupported_response_type')
  if (params.code_challenge_method !== 'S256' || !params.code_challenge || params.code_challenge.length > 128) return fail('invalid_request')
  if (params.resource && params.resource.replace(/\/$/, '') !== mcpResource(env)) return fail('invalid_target')
  return { ok: { client, redirectUri, state: params.state ?? '', codeChallenge: params.code_challenge } }
}

function page(title: string, body: ReturnType<typeof html>, status = 200) {
  return new Response(String(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Agent Connect</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f5f1; --panel: #fff; --ink: #17201b; --muted: #5f6b63; --line: #dfe3dc; --accent: #1f4d36; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111613; --panel: #19201b; --ink: #e8ece7; --muted: #9aa69d; --line: #2c352f; --accent: #7fc49b; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 34rem; margin: 3rem auto; padding: 0 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { font-size: 1.35rem; margin: 0 0 4px; } .muted { color: var(--muted); } .kicker { font-size: 11px; letter-spacing: .12em; color: var(--muted); }
  fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 16px 0; padding: 12px 14px; } legend { font-weight: 600; padding: 0 4px; }
  label { display: flex; gap: 8px; align-items: baseline; margin: 6px 0; } input[type=text], select { flex: 1; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); }
  .app { font-weight: 600; margin: 10px 0 2px; } .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--panel); }
  code { font-size: 13px; }
</style></head><body><main><div class="kicker">AGENT CONNECT</div>${body}</main></body></html>`), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
  })
}

const errorPage = (message: string) => page('Cannot connect', html`<div class="card"><h1>Cannot connect this host</h1><p>${message}</p></div>`, 400)

async function connectedTools(owner: string, env: Env) {
  const connections = await rows<Connection>(env, 'SELECT * FROM connections WHERE owner_sub = ? AND access_token_ciphertext IS NOT NULL ORDER BY created_at', [owner])
  return Promise.all(connections.map(async connection => {
    try { return { connection, tools: (await discoverTools(connection, env)).map(tool => ({ name: tool.name, description: tool.description ?? '' })) } }
    catch { return { connection, tools: null } }
  }))
}

export function registerHostAuth(app: Hono<AppEnv>) {
  const resourceMetadata = (c: Context<AppEnv>) => {
    if (!onMcpHost(c)) return c.text('Not found', 404)
    return c.json({
      resource: mcpResource(c.env),
      authorization_servers: [issuer(c.env)],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Agent Connect',
    }, 200, cors)
  }
  app.get('/.well-known/oauth-protected-resource', resourceMetadata)
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata)

  app.get('/.well-known/oauth-authorization-server', c => {
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
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    }, 200, cors)
  })

  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token']) {
    app.options(path, c => onMcpHost(c) ? c.body(null, 204, cors) : c.text('Not found', 404))
  }

  // Dynamic client registration (RFC 7591). Public clients only; no client secret.
  app.post('/oauth/register', async c => {
    if (!onMcpHost(c)) return c.text('Not found', 404)
    const body = await c.req.json().catch(() => null) as { redirect_uris?: unknown; client_name?: unknown } | null
    const redirects = body?.redirect_uris
    if (!Array.isArray(redirects) || !redirects.length || redirects.length > 10 || !redirects.every(allowedRedirect)) {
      return c.json({ error: 'invalid_redirect_uri' }, 400, cors)
    }
    const name = typeof body?.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : 'MCP host'
    const clientId = `acc_${randomString(16)}`
    await execute(c.env, 'INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)', [clientId, name, JSON.stringify(redirects)])
    return c.json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: redirects,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }, 201, cors)
  })

  // Consent page on the admin origin, behind Cloudflare Access.
  app.get('/oauth/authorize', async c => {
    const checked = await authorizeParams(c.req.query(), c.env)
    if ('page' in checked) return errorPage(checked.page)
    if ('redirect' in checked) return c.redirect(checked.redirect)
    const { client, redirectUri, state, codeChallenge } = checked.ok
    const owner = c.get('owner')
    const [agents, apps] = await Promise.all([
      rows<Pick<Agent, 'id' | 'name'>>(c.env, 'SELECT id, name FROM agents WHERE owner_sub = ? AND revoked_at IS NULL ORDER BY created_at DESC', [owner]),
      connectedTools(owner, c.env),
    ])
    const redirectHost = new URL(redirectUri).host || new URL(redirectUri).protocol
    return page('Connect a host', html`<div class="card">
      <h1>Connect ${client.client_name}</h1>
      <p class="muted">An MCP host wants to use your connected apps through Agent Connect. It will return to <code>${redirectHost}</code>.
        ${client.metadataDocument ? html`Its identity is published at <code>${new URL(client.client_id).host}</code>.` : html`The host chose this name itself; only continue if you just started this connection.`}</p>
      <form method="post" action="/oauth/authorize">
        ${Object.entries({ client_id: client.client_id, redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: 'S256', response_type: 'code' })
          .map(([key, value]) => html`<input type="hidden" name="${key}" value="${value}">`)}
        <fieldset><legend>Agent</legend>
          <label><input type="radio" name="agent_mode" value="new" checked> New agent named <input type="text" name="agent_name" value="${client.client_name}" maxlength="100" aria-label="New agent name"></label>
          ${agents.length ? html`<label><input type="radio" name="agent_mode" value="existing"> Existing agent <select name="agent_id" aria-label="Existing agent">${agents.map(agent => html`<option value="${agent.id}">${agent.name}</option>`)}</select></label>` : ''}
        </fieldset>
        <fieldset><legend>Tools this agent may use</legend>
          ${apps.length ? apps.map(({ connection, tools }) => html`<div class="app">${connection.name}</div>
            ${tools === null ? html`<p class="muted">Could not reach this app right now.</p>` : tools.length ? tools.map(tool => html`<label><input type="checkbox" name="tool" value="${connection.id}::${tool.name}"> <span><code>${tool.name}</code> <span class="muted">${tool.description}</span></span></label>`) : html`<p class="muted">No tools.</p>`}`)
          : html`<p class="muted">No apps connected yet. You can connect apps and grant tools later in the control plane.</p>`}
        </fieldset>
        <div class="actions"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="allow">Allow</button></div>
      </form>
    </div>`)
  })

  app.post('/oauth/authorize', async c => {
    const form = await c.req.parseBody({ all: true }) as Record<string, string | string[]>
    const single = (key: string) => typeof form[key] === 'string' ? form[key] as string : undefined
    const checked = await authorizeParams(Object.fromEntries(['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type'].map(key => [key, single(key)])), c.env)
    if ('page' in checked) return errorPage(checked.page)
    if ('redirect' in checked) return c.redirect(checked.redirect)
    const { client, redirectUri, state, codeChallenge } = checked.ok
    const target = new URL(redirectUri)
    if (state) target.searchParams.set('state', state)
    target.searchParams.set('iss', issuer(c.env))
    if (single('decision') !== 'allow') {
      target.searchParams.set('error', 'access_denied')
      return c.redirect(target.toString())
    }

    const owner = c.get('owner')
    let agentId: string
    if (single('agent_mode') === 'existing') {
      const agent = await first<Agent>(c.env, 'SELECT * FROM agents WHERE id = ? AND owner_sub = ? AND revoked_at IS NULL', [single('agent_id') ?? '', owner])
      if (!agent) return errorPage('That agent no longer exists.')
      agentId = agent.id
    } else {
      const name = (single('agent_name') ?? '').trim() || client.client_name
      if (name.length > 100) return errorPage('Agent names are limited to 100 characters.')
      agentId = crypto.randomUUID()
      await execute(c.env, 'INSERT INTO agents (id, owner_sub, name, token_hash) VALUES (?, ?, ?, NULL)', [agentId, owner, name])
    }

    const requested = ([] as string[]).concat(form.tool ?? []).slice(0, 500)
    const byConnection = new Map<string, Set<string>>()
    for (const value of requested) {
      const [connectionId, toolName] = value.split('::')
      if (!connectionId || !toolName || toolName.length > 255) continue
      if (!byConnection.has(connectionId)) byConnection.set(connectionId, new Set())
      byConnection.get(connectionId)!.add(toolName)
    }
    for (const [connectionId, toolNames] of byConnection) {
      const connection = await first<Connection>(c.env, 'SELECT * FROM connections WHERE id = ? AND owner_sub = ? AND access_token_ciphertext IS NOT NULL', [connectionId, owner])
      if (!connection) continue
      const live = new Set((await discoverTools(connection, c.env).catch(() => [])).map(tool => tool.name))
      for (const toolName of toolNames) {
        if (live.has(toolName)) await execute(c.env, 'INSERT IGNORE INTO grants (agent_id, connection_id, tool_name) VALUES (?, ?, ?)', [agentId, connectionId, toolName])
      }
    }

    const code = randomString(32)
    await execute(c.env, 'INSERT INTO host_auth_codes (code_hash, client_id, agent_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
      await sha256(code), client.client_id, agentId, redirectUri, codeChallenge, dateSql(new Date(Date.now() + CODE_TTL_SECONDS * 1000)),
    ])
    target.searchParams.set('code', code)
    return c.redirect(target.toString())
  })

  app.post('/oauth/token', async c => {
    if (!onMcpHost(c)) return c.text('Not found', 404)
    const form = await c.req.parseBody() as Record<string, string>
    const fail = (error: string, status: 400 | 401 = 400) => c.json({ error }, status, cors)
    if (form.resource && form.resource.replace(/\/$/, '') !== mcpResource(c.env)) return fail('invalid_target')
    const clientId = form.client_id ?? ''

    if (form.grant_type === 'authorization_code') {
      const hash = await sha256(form.code ?? '')
      const record = await first<AuthCode>(c.env, 'SELECT * FROM host_auth_codes WHERE code_hash = ?', [hash])
      if (!record) return fail('invalid_grant')
      const consumed = await execute(c.env, 'DELETE FROM host_auth_codes WHERE code_hash = ?', [hash])
      if (!consumed.rowsAffected || expired(record.expires_at)) return fail('invalid_grant')
      if (record.client_id !== clientId || record.redirect_uri !== form.redirect_uri) return fail('invalid_grant')
      if (await pkceChallenge(form.code_verifier ?? '') !== record.code_challenge) return fail('invalid_grant')
      const agent = await first<Agent>(c.env, 'SELECT * FROM agents WHERE id = ? AND revoked_at IS NULL', [record.agent_id])
      if (!agent) return fail('invalid_grant')
      return c.json(await issueTokens(c.env, agent.id, clientId), 200, cors)
    }

    if (form.grant_type === 'refresh_token') {
      const hash = await sha256(form.refresh_token ?? '')
      const record = await first<AgentToken>(c.env, "SELECT agent_id, client_id, expires_at FROM agent_tokens WHERE token_hash = ? AND kind = 'refresh'", [hash])
      if (!record || record.client_id !== clientId) return fail('invalid_grant')
      // Rotate: each refresh token works once.
      const consumed = await execute(c.env, 'DELETE FROM agent_tokens WHERE token_hash = ?', [hash])
      if (!consumed.rowsAffected || expired(record.expires_at)) return fail('invalid_grant')
      const agent = await first<Agent>(c.env, 'SELECT * FROM agents WHERE id = ? AND revoked_at IS NULL', [record.agent_id])
      if (!agent) return fail('invalid_grant')
      return c.json(await issueTokens(c.env, agent.id, clientId), 200, cors)
    }

    return fail('unsupported_grant_type')
  })
}
