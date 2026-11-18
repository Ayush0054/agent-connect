// Tools as agents see them, and the OpenAPI operations behind the tools of 'openapi' connections.

export type JsonObject = Record<string, unknown>

/** A tool of a connection, whichever way the connection provides it. */
export type Tool = { name: string; description?: string; inputSchema: JsonObject }

/** What a tool call returns to the MCP host. */
export type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[] }

/** Where one tool argument goes in the REST request. */
export type ParamLocation = { name: string; in: 'path' | 'query' | 'body' }

/** One OpenAPI operation, converted to a tool. */
export type ImportedTool = { name: string; description: string; method: string; path: string; inputSchema: JsonObject; params: ParamLocation[] }

export type ImportedSpec = { title: string; baseUrl: string; tools: ImportedTool[] }

/** Row of the `connection_tools` table. `input_schema` and `params` are JSON text. */
export type StoredTool = { connection_id: string; tool_name: string; description: string; method: string; path: string; input_schema: string; params: string }
