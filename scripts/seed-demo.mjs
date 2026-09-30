// Fills a fresh local gateway with demo data: the example app connected,
// three agents with different grants, and a few tool calls.
//   docker compose down -v && docker compose up -d --wait   (fresh database)
//   restart `npm run dev:notes`                            (fresh app state)
//   node scripts/seed-demo.mjs
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const admin = process.env.GATEWAY_ADMIN_URL ?? 'http://localhost:8787'
const mcpBase = process.env.GATEWAY_MCP_URL ?? 'http://127.0.0.1:8787'
const appUrl = process.env.APP_URL ?? 'http://localhost:4000'

async function api(path, body) {
  const response = await fetch(new URL(path, admin), body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {})
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${await response.text()}`)
  return response.json()
}

async function follow(url, init) {
  const response = await fetch(url, { ...init, redirect: 'manual' })
  return new URL(response.headers.get('Location'), url)
}

const { id: connectionId, authorize_url } = await api('/api/connections', { app_url: appUrl })
const consent = await follow(authorize_url)
const form = new URLSearchParams({ decision: 'allow' })
for (const key of ['redirect_uri', 'state', 'code_challenge', 'resource', 'scope']) form.set(key, consent.searchParams.get(key) ?? '')
await follow(await follow(consent, { method: 'POST', body: form }))

const agents = [
  { name: 'Research agent (Agno)', tools: ['list_notes', 'create_note'], notes: ['Summarise Q3 interviews', 'Draft competitor table'] },
  { name: 'Claude Code', tools: ['list_notes', 'create_note'], notes: ['Refactor plan for billing service'] },
  { name: 'Codex', tools: ['list_notes'], notes: [] },
]
for (const spec of agents) {
  const agent = await api('/api/agents', { name: spec.name })
  for (const tool of spec.tools) await api('/api/grants', { agent_id: agent.id, connection_id: connectionId, tool_name: tool })
  const client = new Client({ name: 'seed', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', mcpBase), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }))
  for (const text of spec.notes) await client.callTool({ name: `${connectionId}__create_note`, arguments: { text } })
  await client.callTool({ name: `${connectionId}__list_notes`, arguments: {} })
  await client.close()
}
console.log('Seeded demo data')
