import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server'
import { execute, first, rows, trustedUrl, type Agent, type Connection, type Env, type Grant } from './core'
import { websiteToken } from './oauth'

export async function remoteClient(connection: Connection, env: Env): Promise<Client> {
  const token = await websiteToken(connection, env)
  const client = new Client({ name: 'agent-connect', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } })
  const transport = new StreamableHTTPClientTransport(new URL(trustedUrl(connection.mcp_url)), {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
  })
  await client.connect(transport)
  return client
}

export async function discoverTools(connection: Connection, env: Env) {
  const client = await remoteClient(connection, env)
  try {
    const result = await client.listTools()
    return result.tools
  } finally {
    await client.close()
  }
}

async function authorized(agent: Agent, connection: Connection, tool: string, env: Env): Promise<boolean> {
  const found = await first<Grant>(env,
    'SELECT g.agent_id, g.connection_id, g.tool_name FROM grants g JOIN agents a ON a.id = g.agent_id JOIN connections c ON c.id = g.connection_id WHERE g.agent_id = ? AND g.connection_id = ? AND g.tool_name = ? AND a.revoked_at IS NULL AND a.owner_sub = c.owner_sub AND c.owner_sub = ?',
    [agent.id, connection.id, tool, agent.owner_sub])
  return Boolean(found)
}

async function recordAction(agent: Agent, connection: Connection, tool: string, outcome: string, env: Env) {
  await execute(env, 'INSERT INTO action_log (id, agent_id, connection_id, tool_name, outcome) VALUES (?, ?, ?, ?, ?)', [
    crypto.randomUUID(), agent.id, connection.id, tool, outcome,
  ])
}

export async function serveMcp(request: Request, agent: Agent, env: Env): Promise<Response> {
  const handler = createMcpHandler(async () => {
    const server = new McpServer({ name: 'agent-connect', version: '0.1.0' })
    const grants = await rows<Grant>(env,
      'SELECT g.agent_id, g.connection_id, g.tool_name FROM grants g JOIN connections c ON c.id = g.connection_id WHERE g.agent_id = ? AND c.owner_sub = ?',
      [agent.id, agent.owner_sub])
    const byConnection = new Map<string, Set<string>>()
    for (const grant of grants) {
      if (!byConnection.has(grant.connection_id)) byConnection.set(grant.connection_id, new Set())
      byConnection.get(grant.connection_id)!.add(grant.tool_name)
    }

    for (const [id, allowed] of byConnection) {
      const connection = await first<Connection>(env, 'SELECT * FROM connections WHERE id = ? AND owner_sub = ?', [id, agent.owner_sub])
      if (!connection?.access_token_ciphertext) continue
      let tools: Awaited<ReturnType<typeof discoverTools>>
      try { tools = await discoverTools(connection, env) } catch { continue }
      for (const tool of tools.slice(0, 100)) {
        if (!allowed.has(tool.name)) continue
        const name = `${connection.id}__${tool.name}`
        server.registerTool(name, {
          description: `${connection.name}: ${tool.description}`,
          inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema),
        }, async args => {
          if (!await authorized(agent, connection, tool.name, env)) {
            return { isError: true, content: [{ type: 'text', text: 'Tool grant was revoked' }] }
          }
          let downstream: Client | undefined
          try {
            downstream = await remoteClient(connection, env)
            const result = await downstream.callTool({ name: tool.name, arguments: args }, { toolDefinition: tool })
            await recordAction(agent, connection, tool.name, result.isError ? 'tool_error' : 'success', env)
            return result
          } catch {
            await recordAction(agent, connection, tool.name, 'transport_error', env)
            return { isError: true, content: [{ type: 'text', text: 'Website tool call failed' }] }
          } finally {
            await downstream?.close()
          }
        })
      }
    }
    return server
  }, { responseMode: 'json' })
  return handler.fetch(request)
}
