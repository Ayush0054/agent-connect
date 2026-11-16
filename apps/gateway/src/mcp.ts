import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler, fromJsonSchema, McpServer, type CallToolResult, type JsonSchemaType } from '@modelcontextprotocol/server'
import { execute, first, rows, trustedUrl, type Agent, type Connection, type Env, type Grant } from './core'
import { appToken } from './oauth'
import { agentAssertion } from './assertion'
import { callOperation, storedTools } from './openapi'

export type ListedTool = { name: string; description?: string; inputSchema: Record<string, unknown> }

export async function remoteClient(connection: Connection, env: Env, agent?: Agent, toolName?: string): Promise<Client> {
  const token = await appToken(connection, env)
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (agent && toolName) headers['Agent-Connect-Assertion'] = await agentAssertion(agent, connection, toolName, token, env)
  const client = new Client({ name: 'agent-connect', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } })
  const transport = new StreamableHTTPClientTransport(new URL(trustedUrl(connection.mcp_url, env)), {
    requestInit: { headers, redirect: 'manual' },
  })
  await client.connect(transport)
  return client
}

export async function discoverTools(connection: Connection, env: Env, agent?: Agent) {
  const client = await remoteClient(connection, env, agent, agent ? 'tools/list' : undefined)
  try {
    const result = await client.listTools()
    return result.tools
  } finally {
    await client.close()
  }
}

/** The tools a connection offers: the app's live MCP catalog, or the operations imported from its OpenAPI spec. */
export async function listTools(connection: Connection, env: Env, agent?: Agent): Promise<ListedTool[]> {
  if (connection.kind === 'openapi') {
    return (await storedTools(connection, env)).map(tool => ({ name: tool.tool_name, description: tool.description, inputSchema: JSON.parse(tool.input_schema) }))
  }
  return discoverTools(connection, env, agent)
}

async function authorized(agent: Agent, connection: Connection, tool: string, env: Env): Promise<boolean> {
  const found = await first<Grant>(env,
    'SELECT g.agent_id, g.connection_id, g.tool_name FROM grants g JOIN agents a ON a.id = g.agent_id JOIN connections c ON c.id = g.connection_id WHERE g.agent_id = $1 AND g.connection_id = $2 AND g.tool_name = $3 AND a.revoked_at IS NULL AND a.owner_sub = c.owner_sub AND c.owner_sub = $4',
    [agent.id, connection.id, tool, agent.owner_sub])
  return Boolean(found)
}

async function recordAction(agent: Agent, connection: Connection, tool: string, outcome: string, env: Env) {
  await execute(env, 'INSERT INTO action_log (id, agent_id, connection_id, tool_name, outcome) VALUES ($1, $2, $3, $4, $5)', [
    crypto.randomUUID(), agent.id, connection.id, tool, outcome,
  ])
}

export async function serveMcp(request: Request, agent: Agent, env: Env): Promise<Response> {
  const handler = createMcpHandler(async () => {
    const server = new McpServer({ name: 'agent-connect', version: '0.1.0' })
    const grants = await rows<Grant>(env,
      'SELECT g.agent_id, g.connection_id, g.tool_name FROM grants g JOIN connections c ON c.id = g.connection_id WHERE g.agent_id = $1 AND c.owner_sub = $2',
      [agent.id, agent.owner_sub])
    const byConnection = new Map<string, Set<string>>()
    for (const grant of grants) {
      if (!byConnection.has(grant.connection_id)) byConnection.set(grant.connection_id, new Set())
      byConnection.get(grant.connection_id)!.add(grant.tool_name)
    }

    for (const [id, allowed] of byConnection) {
      const connection = await first<Connection>(env, 'SELECT * FROM connections WHERE id = $1 AND owner_sub = $2', [id, agent.owner_sub])
      if (!connection?.access_token_ciphertext) continue

      type Invoke = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: unknown[] }>
      const register = (toolName: string, description: string | undefined, inputSchema: unknown, invoke: Invoke) => {
        server.registerTool(`${connection.id}__${toolName}`, {
          description: `${connection.name}: ${description ?? ''}`,
          inputSchema: fromJsonSchema<Record<string, unknown>>(inputSchema as JsonSchemaType),
        }, async args => {
          if (!await authorized(agent, connection, toolName, env)) {
            return { isError: true, content: [{ type: 'text', text: 'Tool grant was revoked' }] }
          }
          try {
            const result = await invoke(args)
            await recordAction(agent, connection, toolName, result.isError ? 'tool_error' : 'success', env)
            return result as CallToolResult
          } catch {
            await recordAction(agent, connection, toolName, 'transport_error', env)
            return { isError: true, content: [{ type: 'text', text: 'App tool call failed' }] }
          }
        })
      }

      if (connection.kind === 'openapi') {
        for (const tool of await storedTools(connection, env)) {
          if (!allowed.has(tool.tool_name)) continue
          register(tool.tool_name, tool.description, JSON.parse(tool.input_schema), args => callOperation(connection, tool, args, agent, env))
        }
        continue
      }

      let tools: Awaited<ReturnType<typeof discoverTools>>
      try { tools = await discoverTools(connection, env, agent) } catch { continue }
      for (const tool of tools.slice(0, 100)) {
        if (!allowed.has(tool.name)) continue
        register(tool.name, tool.description, tool.inputSchema, async args => {
          const downstream = await remoteClient(connection, env, agent, tool.name)
          try { return await downstream.callTool({ name: tool.name, arguments: args }, { toolDefinition: tool }) }
          finally { await downstream.close() }
        })
      }
    }
    return server
  }, { responseMode: 'json' })
  return handler.fetch(request)
}
