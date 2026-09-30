// End-to-end check against a locally running gateway and example app:
//   docker compose up -d && npm run dev:gateway && npm run dev:notes
//   node scripts/e2e.mjs
// Connects the app through OAuth, creates two agents with different grants,
// calls tools as each over MCP, then revokes one and checks the other still works.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const admin = process.env.GATEWAY_ADMIN_URL ?? 'http://localhost:8787'
const mcpBase = process.env.GATEWAY_MCP_URL ?? 'http://127.0.0.1:8787'
const appUrl = process.env.APP_URL ?? 'http://localhost:4000'

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(new URL(path, admin), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(data)}`)
  return data
}

async function redirectTarget(url, init) {
  const response = await fetch(url, { ...init, redirect: 'manual' })
  const location = response.headers.get('Location')
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new Error(`Expected redirect from ${url}, got ${response.status}: ${await response.text()}`)
  }
  return new URL(location, url)
}

async function agentClient(token) {
  const client = new Client({ name: 'e2e-host', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', mcpBase), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  return client
}

async function callAs(token, name, args = {}) {
  const client = await agentClient(token)
  try { return await client.callTool({ name, arguments: args }) } finally { await client.close() }
}

async function toolsFor(token) {
  const client = await agentClient(token)
  try { return (await client.listTools()).tools.map(tool => tool.name) } finally { await client.close() }
}

const text = result => result.content?.map(part => part.text ?? '').join('') ?? ''

// 1. Connect the app via discovery + OAuth (the browser steps, done with fetch).
const { id: connectionId, authorize_url } = await api('/api/connections', { method: 'POST', body: { app_url: appUrl } })
const appAuthorize = await redirectTarget(authorize_url)
check('gateway redirects to the app OAuth page', appAuthorize.origin === new URL(appUrl).origin, appAuthorize.pathname)
check('authorization request uses PKCE S256', appAuthorize.searchParams.get('code_challenge_method') === 'S256')
const consent = await fetch(appAuthorize)
check('app shows its consent page', consent.ok)
const form = new URLSearchParams({ decision: 'allow' })
for (const key of ['redirect_uri', 'state', 'code_challenge', 'resource', 'scope']) form.set(key, appAuthorize.searchParams.get(key) ?? '')
const callback = await redirectTarget(appAuthorize, { method: 'POST', body: form })
check('app redirects back to the gateway callback', callback.pathname === '/oauth/callback')
const done = await redirectTarget(callback)
check('gateway stores the app token', done.searchParams.get('connected') === connectionId)

// 2. The live tool catalog.
const { tools } = await api(`/api/connections/${connectionId}/tools`)
check('app tools are listed', tools.map(t => t.name).sort().join(',') === 'create_note,list_notes')

// 3. Two agents, different grants.
const research = await api('/api/agents', { method: 'POST', body: { name: 'Research agent (Agno)' } })
const writer = await api('/api/agents', { method: 'POST', body: { name: 'Codex agent' } })
for (const tool of ['list_notes', 'create_note']) {
  await api('/api/grants', { method: 'POST', body: { agent_id: research.id, connection_id: connectionId, tool_name: tool } })
}
await api('/api/grants', { method: 'POST', body: { agent_id: writer.id, connection_id: connectionId, tool_name: 'list_notes' } })

const prefixed = name => `${connectionId}__${name}`
const researchTools = await toolsFor(research.token)
const writerTools = await toolsFor(writer.token)
check('research agent sees both granted tools', researchTools.length === 2, researchTools.join(', '))
check('codex agent sees only list_notes', writerTools.length === 1 && writerTools[0] === prefixed('list_notes'), writerTools.join(', '))

// 4. Tool calls.
const created = await callAs(research.token, prefixed('create_note'), { text: 'Hello from the research agent' })
check('research agent creates a note', !created.isError, text(created))
const listed = await callAs(writer.token, prefixed('list_notes'))
check('codex agent reads that note', !listed.isError && text(listed).includes('Hello from the research agent'))
const denied = await callAs(writer.token, prefixed('create_note'), { text: 'should not work' }).catch(error => ({ isError: true, content: [{ text: String(error.message) }] }))
check('codex agent cannot call an ungranted tool', denied.isError === true, text(denied).slice(0, 80))

// 5. The app saw each agent's verified identity.
const state = await (await fetch(new URL('/debug/state', appUrl))).json()
check('app attributes the note to the research agent', state.notes.at(-1)?.agentName === 'Research agent (Agno)')
check('app saw both agents by ID', [research.id, writer.id].every(id => state.agents.some(agent => agent.id === id)))

// 6. Revoke one agent; the other keeps working.
await api(`/api/agents/${research.id}/revoke`, { method: 'POST', body: {} })
const revoked = await toolsFor(research.token).then(() => 'connected', error => String(error.message))
check('revoked agent is rejected by the gateway', revoked !== 'connected', revoked.slice(0, 60))
const stillWorks = await callAs(writer.token, prefixed('list_notes'))
check('other agent still works after the revoke', !stillWorks.isError)

// 7. Activity log.
const { actions } = await api('/api/overview')
check('tool calls are in the activity log', actions.some(a => a.agent_id === research.id && a.tool_name === 'create_note' && a.outcome === 'success'))

// 8. Host OAuth: a host that only knows the MCP URL, using the MCP SDK's own OAuth flow.
class MemoryOAuthProvider {
  store = {}
  authorizationUrl = null
  get redirectUrl() { return 'http://127.0.0.1:33418/callback' }
  get clientMetadata() {
    return { client_name: 'E2E Host', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
  }
  clientInformation() { return this.store.client }
  saveClientInformation(info) { this.store.client = info }
  tokens() { return this.store.tokens }
  saveTokens(tokens) { this.store.tokens = tokens }
  redirectToAuthorization(url) { this.authorizationUrl = url }
  saveCodeVerifier(verifier) { this.store.verifier = verifier }
  codeVerifier() { return this.store.verifier }
  saveDiscoveryState(state) { this.store.discovery = state }
  discoveryState() { return this.store.discovery }
}

const provider = new MemoryOAuthProvider()
const hostTransport = () => new StreamableHTTPClientTransport(new URL('/mcp', mcpBase), { authProvider: provider })
const firstTry = new Client({ name: 'e2e-oauth-host', version: '0.0.0' })
const firstTransport = hostTransport()
const unauthorized = await firstTry.connect(firstTransport).then(() => false, () => true)
check('host without a token is sent to authorize', unauthorized && provider.authorizationUrl !== null)
check('host registered itself (DCR)', typeof provider.store.client?.client_id === 'string', provider.store.client?.client_id)

const authorizeUrl = new URL(provider.authorizationUrl)
check('authorize page is on the admin origin', authorizeUrl.origin === new URL(admin).origin)
const consentPage = await fetch(authorizeUrl)
check('consent page names the host', consentPage.ok && (await consentPage.text()).includes('Connect E2E Host'))

const approval = new URLSearchParams({ agent_mode: 'new', agent_name: 'Claude Code (OAuth)', decision: 'allow', tool: `${connectionId}::list_notes` })
for (const key of ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type']) approval.set(key, authorizeUrl.searchParams.get(key) ?? '')
const crossSite = await fetch(new URL('/oauth/authorize', admin), { method: 'POST', body: approval, headers: { Origin: 'https://evil.example' }, redirect: 'manual' })
check('consent POST from another origin is rejected', crossSite.status === 403)
const hostCallback = await redirectTarget(new URL('/oauth/authorize', admin), { method: 'POST', body: approval, headers: { Origin: new URL(admin).origin } })
check('consent redirects to the host callback with a code', hostCallback.origin === 'http://127.0.0.1:33418' && hostCallback.searchParams.has('code'))
check('callback carries the issuer (RFC 9207)', hostCallback.searchParams.get('iss') === new URL(mcpBase).origin)

await firstTransport.finishAuth(hostCallback.searchParams)
check('host received tokens', typeof provider.store.tokens?.access_token === 'string')
const hostClient = new Client({ name: 'e2e-oauth-host', version: '0.0.0' })
await hostClient.connect(hostTransport())
const hostTools = (await hostClient.listTools()).tools.map(tool => tool.name)
check('OAuth host sees exactly the tools picked on the consent page', hostTools.length === 1 && hostTools[0] === prefixed('list_notes'), hostTools.join(', '))
const hostCall = await hostClient.callTool({ name: prefixed('list_notes'), arguments: {} })
check('OAuth host calls an app tool', !hostCall.isError)
await hostClient.close()

const appState = await (await fetch(new URL('/debug/state', appUrl))).json()
check('app sees the OAuth-connected agent by name', appState.agents.some(agent => agent.name === 'Claude Code (OAuth)'))

const oldRefresh = provider.store.tokens.refresh_token
const refreshBody = refresh => new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: provider.store.client.client_id })
const refreshed = await fetch(new URL('/oauth/token', mcpBase), { method: 'POST', body: refreshBody(oldRefresh) })
const newTokens = await refreshed.json()
check('refresh token issues a new access token', refreshed.ok && newTokens.access_token && newTokens.access_token !== provider.store.tokens.access_token)
const replay = await fetch(new URL('/oauth/token', mcpBase), { method: 'POST', body: refreshBody(oldRefresh) })
check('used refresh token cannot be replayed', replay.status === 400)

const hostAgent = (await api('/api/overview')).agents.find(agent => agent.name === 'Claude Code (OAuth)')
await api(`/api/agents/${hostAgent.id}/revoke`, { method: 'POST', body: {} })
const afterRevoke = await toolsFor(newTokens.access_token).then(() => 'connected', error => String(error.message))
check('revoking the agent invalidates its OAuth tokens', afterRevoke !== 'connected')
const refreshAfterRevoke = await fetch(new URL('/oauth/token', mcpBase), { method: 'POST', body: refreshBody(newTokens.refresh_token) })
check('revoked agent cannot refresh', refreshAfterRevoke.status === 400)

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
