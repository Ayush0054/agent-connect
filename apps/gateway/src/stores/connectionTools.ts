// Tools imported from an OpenAPI spec. MCP connections have no rows here: their tools are read live from the app.
import type { Env } from '../types/env'
import type { ImportedTool, StoredTool } from '../types/tools'
import { execute, rows } from './db'

export function listConnectionTools(env: Env, connectionId: string): Promise<StoredTool[]> {
  return rows(env, 'SELECT * FROM connection_tools WHERE connection_id = $1 ORDER BY path, method', [connectionId])
}

/** Replace all tools of a connection with a fresh import. */
export async function replaceConnectionTools(env: Env, connectionId: string, tools: ImportedTool[]): Promise<void> {
  await deleteConnectionTools(env, connectionId)
  for (const tool of tools) {
    await execute(env, 'INSERT INTO connection_tools (connection_id, tool_name, description, method, path, input_schema, params) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      connectionId, tool.name, tool.description, tool.method, tool.path, JSON.stringify(tool.inputSchema), JSON.stringify(tool.params),
    ])
  }
}

export async function deleteConnectionTools(env: Env, connectionId: string): Promise<void> {
  await execute(env, 'DELETE FROM connection_tools WHERE connection_id = $1', [connectionId])
}
