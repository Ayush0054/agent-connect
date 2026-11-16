export type Agent = { id: string; name: string; created_at: string; revoked_at: string | null }
export type Connection = { id: string; name: string; kind: 'mcp' | 'openapi'; auth_kind: 'oauth' | 'api_key'; mcp_url: string; connected_at: string | null }
export type Grant = { agent_id: string; connection_id: string; tool_name: string }
export type Action = { id: string; agent_id: string; connection_id: string; tool_name: string; outcome: string; created_at: string }
export type Tool = { name: string; description?: string; inputSchema: Record<string, unknown> }
export type Overview = { agents: Agent[]; connections: Connection[]; grants: Grant[]; actions: Action[]; mcp_url: string }

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  })
  const data = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`)
  return data
}

export function send<T>(path: string, body: Record<string, unknown>, method = 'POST') {
  return api<T>(path, { method, body: JSON.stringify(body) })
}
