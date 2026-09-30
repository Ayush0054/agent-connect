// A tiny "Notes" app for local end-to-end testing of Agent Connect.
// It has its own OAuth authorization server, an MCP server, and uses
// @agent-connect/server-sdk to publish discovery and verify each agent call.
// Everything is in memory; restart the process to reset.
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { html } from 'hono/html'
import { createMcpHandler, McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { AgentConnectAuthError, createAgentConnectIntegration, type AgentContext } from '@agent-connect/server-sdk'

const port = Number(process.env.PORT ?? 4000)
const origin = process.env.APP_ORIGIN ?? `http://localhost:${port}`
const gatewayAdmin = process.env.GATEWAY_ADMIN_URL ?? 'http://localhost:8787'
const gatewayMcp = process.env.GATEWAY_MCP_URL ?? 'http://127.0.0.1:8787'
const accessTokenTtl = Number(process.env.ACCESS_TOKEN_TTL ?? 3600)

const clientId = 'agent-connect'
const redirectUri = `${gatewayAdmin}/oauth/callback`
const mcpUrl = new URL('/mcp', origin).toString()
const userId = 'alice'

type Grant = { userId: string; resource: string; scope: string }
const codes = new Map<string, Grant & { challenge: string; expiresAt: number }>()
const accessTokens = new Map<string, Grant & { expiresAt: number }>()
const refreshTokens = new Map<string, Grant>()
const notes: { id: number; userId: string; text: string; agentName: string; createdAt: string }[] = []
const agentsSeen = new Map<string, { name: string; tools: Set<string>; lastSeen: string }>()

function randomToken(prefix: string): string {
  return `${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url')}`
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return Buffer.from(digest).toString('base64url')
}

function issueTokens(grant: Grant) {
  const access = randomToken('notes_at')
  const refresh = randomToken('notes_rt')
  accessTokens.set(access, { ...grant, expiresAt: Date.now() + accessTokenTtl * 1000 })
  refreshTokens.set(refresh, grant)
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: accessTokenTtl, scope: grant.scope }
}

function validAccessToken(token: string): Grant | null {
  const grant = accessTokens.get(token)
  if (!grant || grant.expiresAt <= Date.now() || grant.resource !== mcpUrl) return null
  return grant
}

const agentConnect = createAgentConnectIntegration({
  name: 'Notes (example)',
  mcpUrl,
  oauth: { authorizationUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, clientId, scope: 'notes' },
  gatewayIssuer: gatewayMcp,
  verifyAccessToken: async token => {
    const grant = validAccessToken(token)
    return grant ? { userId: grant.userId } : null
  },
})

async function verified(ctx: ServerContext, toolName: string): Promise<AgentContext> {
  const request = ctx.http?.req
  if (!request) throw new AgentConnectAuthError('Missing HTTP request')
  const agent = await agentConnect.verifyToolCall(request, toolName)
  const seen = agentsSeen.get(agent.agentId) ?? { name: agent.agentName ?? agent.agentId, tools: new Set(), lastSeen: '' }
  seen.tools.add(toolName)
  seen.lastSeen = new Date().toISOString()
  agentsSeen.set(agent.agentId, seen)
  return agent
}

function refused(error: unknown) {
  const message = error instanceof AgentConnectAuthError ? error.message : 'Tool failed'
  return { isError: true, content: [{ type: 'text' as const, text: message }] }
}

function mcpServer() {
  const server = new McpServer({ name: 'notes-example', version: '0.1.0' })
  server.registerTool('list_notes', { description: 'List your notes' }, async ctx => {
    try {
      const agent = await verified(ctx, 'list_notes')
      const mine = notes.filter(note => note.userId === agent.appUserId)
      return { content: [{ type: 'text', text: JSON.stringify(mine) }] }
    } catch (error) { return refused(error) }
  })
  server.registerTool('create_note', {
    description: 'Create a note',
    inputSchema: z.object({ text: z.string().min(1).max(500) }),
  }, async ({ text }, ctx) => {
    try {
      const agent = await verified(ctx, 'create_note')
      const note = { id: notes.length + 1, userId: agent.appUserId, text, agentName: agent.agentName ?? agent.agentId, createdAt: new Date().toISOString() }
      notes.push(note)
      return { content: [{ type: 'text', text: `Created note ${note.id}` }] }
    } catch (error) { return refused(error) }
  })
  return server
}

const mcp = createMcpHandler(mcpServer, { responseMode: 'json' })
const app = new Hono()

app.get('/.well-known/agent-connect.json', () => agentConnect.discoveryResponse())

app.all('/mcp', async c => {
  const header = c.req.header('Authorization') ?? ''
  if (!header.startsWith('Bearer ') || !validAccessToken(header.slice(7))) {
    return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer' })
  }
  return mcp.fetch(c.req.raw)
})

app.get('/oauth/authorize', c => {
  const q = c.req.query()
  if (q.client_id !== clientId || q.redirect_uri !== redirectUri) return c.text('Unknown client or redirect URI', 400)
  if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge) return c.text('PKCE authorization code flow required', 400)
  if (q.resource !== mcpUrl) return c.text('Unknown resource', 400)
  return c.html(html`<!doctype html><title>Notes · Authorize</title>
    <body style="font-family:system-ui;max-width:28rem;margin:4rem auto">
      <h1>Notes</h1>
      <p>Signed in as <b>${userId}</b>.</p>
      <p><b>Agent Connect</b> wants access to your notes (<code>${q.scope ?? ''}</code>). You will choose which agents get which tools in Agent Connect.</p>
      <form method="post">
        ${['redirect_uri', 'state', 'code_challenge', 'resource', 'scope'].map(key => html`<input type="hidden" name="${key}" value="${q[key] ?? ''}">`)}
        <button name="decision" value="allow">Allow</button> <button name="decision" value="deny">Deny</button>
      </form>
    </body>`)
})

app.post('/oauth/authorize', async c => {
  const form = await c.req.parseBody() as Record<string, string>
  if (form.redirect_uri !== redirectUri || form.resource !== mcpUrl) return c.text('Invalid request', 400)
  const target = new URL(redirectUri)
  target.searchParams.set('state', form.state ?? '')
  if (form.decision !== 'allow') {
    target.searchParams.set('error', 'access_denied')
    return c.redirect(target.toString())
  }
  const code = randomToken('notes_code')
  codes.set(code, { userId, resource: form.resource, scope: form.scope ?? '', challenge: form.code_challenge ?? '', expiresAt: Date.now() + 60_000 })
  target.searchParams.set('code', code)
  return c.redirect(target.toString())
})

app.post('/oauth/token', async c => {
  const form = await c.req.parseBody() as Record<string, string>
  const fail = (error: string) => c.json({ error }, 400)
  if (form.client_id !== clientId) return fail('invalid_client')
  if (form.resource && form.resource !== mcpUrl) return fail('invalid_target')
  if (form.grant_type === 'authorization_code') {
    const record = codes.get(form.code ?? '')
    codes.delete(form.code ?? '')
    if (!record || record.expiresAt <= Date.now() || form.redirect_uri !== redirectUri) return fail('invalid_grant')
    if (await s256(form.code_verifier ?? '') !== record.challenge) return fail('invalid_grant')
    return c.json(issueTokens(record))
  }
  if (form.grant_type === 'refresh_token') {
    const grant = refreshTokens.get(form.refresh_token ?? '')
    refreshTokens.delete(form.refresh_token ?? '')
    if (!grant) return fail('invalid_grant')
    return c.json(issueTokens(grant))
  }
  return fail('unsupported_grant_type')
})

// The app's own view: which agents acted, as verified by the SDK.
app.get('/', c => c.html(html`<!doctype html><title>Notes</title>
  <body style="font-family:system-ui;max-width:40rem;margin:3rem auto">
    <h1>Notes <small style="color:#888">example app</small></h1>
    <h2>Agents seen</h2>
    <ul>${[...agentsSeen].map(([id, a]) => html`<li><b>${a.name}</b> <code>${id}</code> used ${[...a.tools].join(', ')} · last ${a.lastSeen}</li>`)}</ul>
    <h2>Notes</h2>
    <ul>${notes.map(n => html`<li>${n.text} <small>by ${n.agentName}</small></li>`)}</ul>
  </body>`))

app.get('/debug/state', c => c.json({
  notes,
  agents: [...agentsSeen].map(([id, a]) => ({ id, name: a.name, tools: [...a.tools] })),
}))

serve({ fetch: app.fetch, port }, () => console.log(`Notes example app on ${origin} (MCP ${mcpUrl})`))
