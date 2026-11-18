// The request and response shapes are the gateway's control-plane contract, so both sides are checked against one definition.
import type { ActionSummary, AgentSummary, ConnectionSummary, OverviewResponse } from '../../gateway/src/types/api'

export type { ConnectResponse, CreateAgentResponse, Grant, Tool, ToolsResponse } from '../../gateway/src/types/api'
export type Agent = AgentSummary
export type Connection = ConnectionSummary
export type Action = ActionSummary
export type Overview = OverviewResponse

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
