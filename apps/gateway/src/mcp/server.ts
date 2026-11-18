// The MCP server an agent talks to. It is built per request and contains only the tools
// this agent was granted, named `<connection id>__<tool>`.
import { createMcpHandler, fromJsonSchema, McpServer, type CallToolResult, type JsonSchemaType } from '@modelcontextprotocol/server'
import { MAX_MCP_TOOLS, SERVER_INFO } from '../constants'
import { recordAction } from '../stores/actionLog'
import { listConnectionTools } from '../stores/connectionTools'
import { getConnection } from '../stores/connections'
import { hasGrant, listGrantsForAgent } from '../stores/grants'
import type { Agent } from '../types/agents'
import type { Env } from '../types/env'
import { callMcpTool, discoverTools, type McpAppTool } from '../upstream/mcpApp'
import { callOperation } from '../upstream/restApp'

type Invoke = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: unknown[] }>

export async function serveMcp(request: Request, agent: Agent, env: Env): Promise<Response> {
  const handler = createMcpHandler(async () => {
    const server = new McpServer(SERVER_INFO)
    const allowedByConnection = new Map<string, Set<string>>()
    for (const grant of await listGrantsForAgent(env, agent)) {
      if (!allowedByConnection.has(grant.connection_id)) allowedByConnection.set(grant.connection_id, new Set())
      allowedByConnection.get(grant.connection_id)!.add(grant.tool_name)
    }

    for (const [id, allowed] of allowedByConnection) {
      const connection = await getConnection(env, id, agent.owner_sub)
      if (!connection?.access_token_ciphertext) continue

      // Every tool call checks the grant again, calls the app, and writes the outcome to the activity log.
      const register = (toolName: string, description: string | undefined, inputSchema: unknown, invoke: Invoke) => {
        server.registerTool(`${connection.id}__${toolName}`, {
          description: `${connection.name}: ${description ?? ''}`,
          inputSchema: fromJsonSchema<Record<string, unknown>>(inputSchema as JsonSchemaType),
        }, async args => {
          if (!await hasGrant(env, agent, connection.id, toolName)) {
            return { isError: true, content: [{ type: 'text', text: 'Tool grant was revoked' }] }
          }
          try {
            const result = await invoke(args)
            await recordAction(env, agent, connection.id, toolName, result.isError ? 'tool_error' : 'success')
            return result as CallToolResult
          } catch {
            await recordAction(env, agent, connection.id, toolName, 'transport_error')
            return { isError: true, content: [{ type: 'text', text: 'App tool call failed' }] }
          }
        })
      }

      if (connection.kind === 'openapi') {
        for (const tool of await listConnectionTools(env, connection.id)) {
          if (!allowed.has(tool.tool_name)) continue
          register(tool.tool_name, tool.description, JSON.parse(tool.input_schema), args => callOperation(connection, tool, args, agent, env))
        }
        continue
      }

      let tools: McpAppTool[]
      try { tools = await discoverTools(connection, env, agent) } catch { continue }
      for (const tool of tools.slice(0, MAX_MCP_TOOLS)) {
        if (!allowed.has(tool.name)) continue
        register(tool.name, tool.description, tool.inputSchema, args => callMcpTool(connection, tool, args, agent, env))
      }
    }
    return server
  }, { responseMode: 'json' })
  return handler.fetch(request)
}
