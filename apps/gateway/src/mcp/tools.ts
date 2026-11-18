import { listConnectionTools } from '../stores/connectionTools'
import type { Agent } from '../types/agents'
import type { Connection } from '../types/connections'
import type { Env } from '../types/env'
import type { Tool } from '../types/tools'
import { discoverTools } from '../upstream/mcpApp'

/** The tools a connection offers: the app's live MCP catalog, or the operations imported from its OpenAPI spec. */
export async function listTools(connection: Connection, env: Env, agent?: Agent): Promise<Tool[]> {
  if (connection.kind === 'openapi') {
    const stored = await listConnectionTools(env, connection.id)
    return stored.map(tool => ({ name: tool.tool_name, description: tool.description, inputSchema: JSON.parse(tool.input_schema) }))
  }
  return discoverTools(connection, env, agent)
}
