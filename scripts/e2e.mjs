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

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
