// Calls to an app that runs its own MCP server.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ASSERTION_HEADER, SERVER_INFO } from '../constants'
import type { Agent } from '../types/agents'
import type { Connection } from '../types/connections'
import type { Env } from '../types/env'
import { trustedUrl } from '../utils/urls'
import { appToken } from './appOAuth'
import { agentAssertion } from './assertion'

/** An MCP client connected to the app. With `agent` and `toolName`, the request also says which agent is acting. */
export async function remoteClient(connection: Connection, env: Env, agent?: Agent, toolName?: string): Promise<Client> {
  const token = await appToken(connection, env)
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (agent && toolName) headers[ASSERTION_HEADER] = await agentAssertion(agent, connection, toolName, token, env)
  const client = new Client(SERVER_INFO, { versionNegotiation: { mode: 'auto' } })
  const transport = new StreamableHTTPClientTransport(new URL(trustedUrl(connection.mcp_url, env)), {
    requestInit: { headers, redirect: 'manual' },
  })
  await client.connect(transport)
  return client
}

/** The app's live tool list. */
export async function discoverTools(connection: Connection, env: Env, agent?: Agent) {
  const client = await remoteClient(connection, env, agent, agent ? 'tools/list' : undefined)
  try {
    const result = await client.listTools()
    return result.tools
  } finally {
    await client.close()
  }
}

export type McpAppTool = Awaited<ReturnType<typeof discoverTools>>[number]

export async function callMcpTool(connection: Connection, tool: McpAppTool, args: Record<string, unknown>, agent: Agent, env: Env) {
  const client = await remoteClient(connection, env, agent, tool.name)
  try { return await client.callTool({ name: tool.name, arguments: args }, { toolDefinition: tool }) }
  finally { await client.close() }
}
