// End-to-end check of the OpenAPI adapter against a locally running gateway
// and the legacy example API (a REST service with no MCP server and no OAuth):
//   docker compose up -d && npm run dev:gateway && npm run dev:legacy
//   node scripts/e2e-openapi.mjs
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const admin = process.env.GATEWAY_ADMIN_URL ?? 'http://localhost:8787'
const mcpBase = process.env.GATEWAY_MCP_URL ?? 'http://127.0.0.1:8787'
const legacyUrl = process.env.LEGACY_URL ?? 'http://localhost:4100'
const legacyKey = process.env.LEGACY_API_KEY ?? 'legacy-demo-key'

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(new URL(path, admin), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, data: await response.json().catch(() => ({})) }
}

async function api(path, options) {
  const { status, data } = await request(path, options)
  if (status >= 400) throw new Error(`${options?.method ?? 'GET'} ${path} -> ${status} ${JSON.stringify(data)}`)
  return data
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
  try { return await client.callTool({ name, arguments: args }) }
  catch (error) { return { isError: true, content: [{ text: String(error.message) }] } }
  finally { await client.close() }
}

async function toolsFor(token) {
  const client = await agentClient(token)
  try { return (await client.listTools()).tools } finally { await client.close() }
}

const text = result => result.content?.map(part => part.text ?? '').join('') ?? ''
const legacyState = async () => (await fetch(new URL('/debug/state', legacyUrl))).json()
const importBody = extra => ({ kind: 'openapi', spec_url: `${legacyUrl}/openapi.json`, auth: { type: 'api_key', header: 'X-API-Key', value: legacyKey }, ...extra })

// 1. Import the spec with an API key. No browser step, no code on the app side.
const connection = await api('/api/connections', { method: 'POST', body: importBody() })
const connectionId = connection.id
check('spec is imported and named from its title', connection.name === 'Legacy Tasks' && connection.tools_imported === 5, `${connection.name}, ${connection.tools_imported} tools`)
check('base URL comes from the spec servers entry', connection.base_url === `${legacyUrl}/api`, connection.base_url)

const overview = await api('/api/overview')
const listed = overview.connections.find(item => item.id === connectionId)
check('connection is connected without OAuth', listed?.kind === 'openapi' && listed?.auth_kind === 'api_key' && Boolean(listed?.connected_at))
check('the API key is not returned by the API', !JSON.stringify(overview).includes(legacyKey))

const { tools } = await api(`/api/connections/${connectionId}/tools`)
const names = tools.map(tool => tool.name).sort().join(',')
check('each operation is a tool', names === 'create_task,delete_task,get_task,list_tasks,update_task', names)
const update = tools.find(tool => tool.name === 'update_task')
check('path parameter and JSON body are in the input schema', update?.inputSchema.required?.includes('id') && update?.inputSchema.properties?.body?.properties?.title?.type === 'string', JSON.stringify(update?.inputSchema.required))
check('$ref is inlined and nullable is translated', JSON.stringify(update?.inputSchema.properties?.body?.properties?.done?.type) === '["boolean","null"]')

// 2. Bad imports are refused.
const badKind = await request('/api/connections', { method: 'POST', body: importBody({ spec_url: `${legacyUrl}/debug/state` }) })
check('a document that is not OpenAPI 3 is rejected', badKind.status === 422, badKind.data.error)
const internalBase = await request('/api/connections', { method: 'POST', body: importBody({ base_url: 'http://169.254.169.254/latest' }) })
check('a base URL on a non-loopback IP address is rejected', internalBase.status === 422, internalBase.data.error)
const badHeader = await request('/api/connections', { method: 'POST', body: importBody({ auth: { type: 'api_key', header: 'Host', value: legacyKey } }) })
check('a reserved credential header is rejected', badHeader.status === 400, badHeader.data.error)

// 3. Two agents with different grants.
const reader = await api('/api/agents', { method: 'POST', body: { name: 'Read-only agent' } })
const editor = await api('/api/agents', { method: 'POST', body: { name: 'Editor agent' } })
const grant = (agent, tool) => api('/api/grants', { method: 'POST', body: { agent_id: agent.id, connection_id: connectionId, tool_name: tool } })
await grant(reader, 'list_tasks')
for (const tool of ['list_tasks', 'create_task', 'get_task', 'update_task']) await grant(editor, tool)
const unknownGrant = await request('/api/grants', { method: 'POST', body: { agent_id: reader.id, connection_id: connectionId, tool_name: 'drop_database' } })
check('a tool that is not in the spec cannot be granted', unknownGrant.status === 404)

const prefixed = name => `${connectionId}__${name}`
const readerTools = (await toolsFor(reader.token)).map(tool => tool.name)
check('read-only agent sees only list_tasks', readerTools.length === 1 && readerTools[0] === prefixed('list_tasks'), readerTools.join(', '))
check('editor agent sees its four tools', (await toolsFor(editor.token)).length === 4)

// 4. Tool calls become REST calls.
const before = await legacyState()
const created = await callAs(editor.token, prefixed('create_task'), { body: { title: 'Written by an agent' } })
const task = created.isError ? null : JSON.parse(text(created))
check('POST with a JSON body creates a task', task?.title === 'Written by an agent', text(created).slice(0, 80))
const fetched = await callAs(editor.token, prefixed('get_task'), { id: task?.id })
check('GET fills the path parameter', !fetched.isError && JSON.parse(text(fetched)).id === task?.id)
const patched = await callAs(editor.token, prefixed('update_task'), { id: task?.id, body: { done: true } })
check('PATCH sends path parameter and body together', !patched.isError && JSON.parse(text(patched)).done === true)
const filtered = await callAs(reader.token, prefixed('list_tasks'), { done: true })
const doneTasks = filtered.isError ? [] : JSON.parse(text(filtered))
check('GET sends the query parameter', doneTasks.length === 1 && doneTasks[0].id === task?.id, text(filtered).slice(0, 80))
const missing = await callAs(editor.token, prefixed('get_task'), { id: 99999 })
check('an HTTP error from the app is a tool error', missing.isError === true && text(missing).includes('404'), text(missing).slice(0, 60))
const invalid = await callAs(editor.token, prefixed('create_task'), { body: {} })
check('arguments that break the schema are refused', invalid.isError === true, text(invalid).slice(0, 80))
const denied = await callAs(reader.token, prefixed('create_task'), { body: { title: 'should not work' } })
check('read-only agent cannot call an ungranted tool', denied.isError === true, text(denied).slice(0, 60))

const after = await legacyState()
check('the app received the API key on every call', after.seen.apiKeyCalls - before.seen.apiKeyCalls === 5, `${after.seen.apiKeyCalls - before.seen.apiKeyCalls} calls`)
check('each call carried a signed agent assertion', after.seen.assertions - before.seen.assertions === 5)
check('the ungranted call never reached the app', !after.tasks.some(item => item.title === 'should not work'))

// 5. Activity log, revoke, refresh, disconnect.
const { actions } = await api('/api/overview')
check('calls are in the activity log', actions.some(a => a.agent_id === editor.id && a.tool_name === 'create_task' && a.outcome === 'success')
  && actions.some(a => a.agent_id === editor.id && a.tool_name === 'get_task' && a.outcome === 'tool_error'))

await api(`/api/agents/${editor.id}/revoke`, { method: 'POST', body: {} })
const revoked = await toolsFor(editor.token).then(() => 'connected', error => String(error.message))
check('revoked agent is rejected', revoked !== 'connected', revoked.slice(0, 60))
check('other agent still works after the revoke', !(await callAs(reader.token, prefixed('list_tasks'))).isError)

const refreshed = await api(`/api/connections/${connectionId}/refresh`, { method: 'POST', body: {} })
check('spec can be re-imported', refreshed.tools_imported === 5)
check('grants survive a re-import', (await toolsFor(reader.token)).length === 1)

await api(`/api/connections/${connectionId}/disconnect`, { method: 'POST', body: {} })
const gone = await api('/api/overview')
check('disconnect removes the connection and its key', !gone.connections.some(item => item.id === connectionId))
check('disconnected tools disappear for the agent', (await toolsFor(reader.token)).length === 0)

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
