// /oauth: both OAuth roles of Agent Connect.
//   register, authorize, token — Agent Connect is the authorization server for MCP hosts.
//   callback                   — Agent Connect is a client of a connected app.
// `authorize` and `callback` are on the admin origin behind `adminAuth`; `register` and `token` are on the MCP origin.
import { Hono } from 'hono'
import { CODE_TTL_SECONDS } from '../constants'
import { allowedRedirect, authorizeParams, issuer, issueTokens, mcpResource } from '../hostAuth/authorize'
import { consentPage, errorPage } from '../hostAuth/pages'
import { listTools } from '../mcp/tools'
import { getActiveAgent, getActiveAgentById, insertAgent, listActiveAgents } from '../stores/agents'
import { getConnection, listConnectedConnections } from '../stores/connections'
import { insertGrant } from '../stores/grants'
import { consumeAgentToken, consumeAuthCode, getAuthCode, getRefreshToken, insertAuthCode, insertHostClient } from '../stores/hostAuth'
import type { AppEnv, Env } from '../types/env'
import { oauthCallback } from '../upstream/appOAuth'
import { pkceChallenge, randomString, sha256 } from '../utils/crypto'
import { cors, onMcpHost } from './wellKnown'

const expired = (value: Date) => value.getTime() <= Date.now()

async function connectedApps(owner: string, env: Env) {
  const connections = await listConnectedConnections(env, owner)
  return Promise.all(connections.map(async connection => {
    try { return { connection, tools: (await listTools(connection, env)).map(tool => ({ name: tool.name, description: tool.description ?? '' })) } }
    catch { return { connection, tools: null } }
  }))
}

export const oauthRoutes = new Hono<AppEnv>()

for (const path of ['/register', '/token']) {
  oauthRoutes.options(path, c => onMcpHost(c) ? c.body(null, 204, cors) : c.text('Not found', 404))
}

// Dynamic client registration (RFC 7591). Public clients only; no client secret.
oauthRoutes.post('/register', async c => {
  if (!onMcpHost(c)) return c.text('Not found', 404)
  const body = await c.req.json().catch(() => null) as { redirect_uris?: unknown; client_name?: unknown } | null
  const redirects = body?.redirect_uris
  if (!Array.isArray(redirects) || !redirects.length || redirects.length > 10 || !redirects.every(allowedRedirect)) {
    return c.json({ error: 'invalid_redirect_uri' }, 400, cors)
  }
  const name = typeof body?.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : 'MCP host'
  const clientId = `acc_${randomString(16)}`
  await insertHostClient(c.env, { clientId, name, redirectUris: redirects })
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

// Consent page: the user picks or creates an agent and chooses its tools.
oauthRoutes.get('/authorize', async c => {
  const checked = await authorizeParams(c.req.query(), c.env)
  if ('page' in checked) return errorPage(checked.page)
  if ('redirect' in checked) return c.redirect(checked.redirect)
  const owner = c.get('owner')
  const [agents, apps] = await Promise.all([listActiveAgents(c.env, owner), connectedApps(owner, c.env)])
  return consentPage(checked.ok, agents, apps)
})

// The consent form: create the agent and grants, then send the host back with a one-time code.
oauthRoutes.post('/authorize', async c => {
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
    const agent = await getActiveAgent(c.env, single('agent_id') ?? '', owner)
    if (!agent) return errorPage('That agent no longer exists.')
    agentId = agent.id
  } else {
    const name = (single('agent_name') ?? '').trim() || client.client_name
    if (name.length > 100) return errorPage('Agent names are limited to 100 characters.')
    agentId = crypto.randomUUID()
    await insertAgent(c.env, { id: agentId, owner, name, tokenHash: null })
  }

  // Checkbox values are `<connection id>::<tool>`. Only tools the app really has are granted.
  const requested = ([] as string[]).concat(form.tool ?? []).slice(0, 500)
  const byConnection = new Map<string, Set<string>>()
  for (const value of requested) {
    const [connectionId, toolName] = value.split('::')
    if (!connectionId || !toolName || toolName.length > 255) continue
    if (!byConnection.has(connectionId)) byConnection.set(connectionId, new Set())
    byConnection.get(connectionId)!.add(toolName)
  }
  for (const [connectionId, toolNames] of byConnection) {
    const connection = await getConnection(c.env, connectionId, owner)
    if (!connection?.access_token_ciphertext) continue
    const live = new Set((await listTools(connection, c.env).catch(() => [])).map(tool => tool.name))
    for (const toolName of toolNames) {
      if (live.has(toolName)) await insertGrant(c.env, { agent_id: agentId, connection_id: connectionId, tool_name: toolName })
    }
  }

  const code = randomString(32)
  await insertAuthCode(c.env, {
    codeHash: await sha256(code),
    clientId: client.client_id,
    agentId,
    redirectUri,
    codeChallenge,
    expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
  })
  target.searchParams.set('code', code)
  return c.redirect(target.toString())
})

oauthRoutes.post('/token', async c => {
  if (!onMcpHost(c)) return c.text('Not found', 404)
  const form = await c.req.parseBody() as Record<string, string>
  const fail = (error: string, status: 400 | 401 = 400) => c.json({ error }, status, cors)
  if (form.resource && form.resource.replace(/\/$/, '') !== mcpResource(c.env)) return fail('invalid_target')
  const clientId = form.client_id ?? ''

  if (form.grant_type === 'authorization_code') {
    const hash = await sha256(form.code ?? '')
    const record = await getAuthCode(c.env, hash)
    if (!record) return fail('invalid_grant')
    if (!await consumeAuthCode(c.env, hash) || expired(record.expires_at)) return fail('invalid_grant')
    if (record.client_id !== clientId || record.redirect_uri !== form.redirect_uri) return fail('invalid_grant')
    if (await pkceChallenge(form.code_verifier ?? '') !== record.code_challenge) return fail('invalid_grant')
    const agent = await getActiveAgentById(c.env, record.agent_id)
    if (!agent) return fail('invalid_grant')
    return c.json(await issueTokens(c.env, agent.id, clientId), 200, cors)
  }

  if (form.grant_type === 'refresh_token') {
    const hash = await sha256(form.refresh_token ?? '')
    const record = await getRefreshToken(c.env, hash)
    if (!record || record.client_id !== clientId) return fail('invalid_grant')
    // Rotate: each refresh token works once.
    if (!await consumeAgentToken(c.env, hash) || expired(record.expires_at)) return fail('invalid_grant')
    const agent = await getActiveAgentById(c.env, record.agent_id)
    if (!agent) return fail('invalid_grant')
    return c.json(await issueTokens(c.env, agent.id, clientId), 200, cors)
  }

  return fail('unsupported_grant_type')
})

// A connected app sends the user back here after they signed in to it.
oauthRoutes.get('/callback', c => oauthCallback(c.req.raw, c.get('owner'), c.env))
