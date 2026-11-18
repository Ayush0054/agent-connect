// Calls to an app that only has a REST API: turn a tool call into one HTTP request.
import { APP_CALL_TIMEOUT_MS, ASSERTION_HEADER, MAX_RESPONSE_BYTES } from '../constants'
import type { Agent } from '../types/agents'
import type { Connection } from '../types/connections'
import type { Env } from '../types/env'
import type { ParamLocation, StoredTool, ToolResult } from '../types/tools'
import { readLimitedText } from '../utils/http'
import { trustedUrl } from '../utils/urls'
import { appToken } from './appOAuth'
import { agentAssertion } from './assertion'

// Headers the gateway sets itself, so they cannot carry the API key.
const reservedHeaders = new Set(['host', 'content-length', 'content-type', 'accept', ASSERTION_HEADER.toLowerCase()])

/** How an API key is sent: a header name and an optional prefix such as "Bearer ". Returns null when either is invalid. */
export function apiKeyHeader(header: unknown, prefix: unknown): { header: string; prefix: string } | null {
  const name = typeof header === 'string' && header.trim() ? header.trim() : 'Authorization'
  const lead = typeof prefix === 'string' ? prefix : name.toLowerCase() === 'authorization' ? 'Bearer ' : ''
  // RFC 9110 token characters; real APIs use names such as `api_key`.
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,255}$/.test(name) || reservedHeaders.has(name.toLowerCase())) return null
  if (lead.length > 64 || !/^[\x20-\x7e]*$/.test(lead)) return null
  return { header: name, prefix: lead }
}

function credentialHeader(connection: Connection, token: string): [string, string] {
  if (connection.auth_kind === 'api_key') return [connection.auth_header || 'Authorization', `${connection.auth_prefix ?? ''}${token}`]
  return ['Authorization', `Bearer ${token}`]
}

function queryValue(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
}

const failed = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

/** Send the REST request for one tool call. HTTP errors from the app become tool errors; redirects are not followed. */
export async function callOperation(connection: Connection, tool: StoredTool, args: Record<string, unknown>, agent: Agent, env: Env): Promise<ToolResult> {
  const params = JSON.parse(tool.params) as ParamLocation[]
  const base = new URL(trustedUrl(connection.mcp_url, env))

  let invalid = ''
  const path = tool.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = args[name]
    const segment = value === undefined || value === null || typeof value === 'object' ? '' : String(value)
    // "." and ".." survive percent-encoding and would let an argument reach a different endpoint.
    if (!segment || segment === '.' || segment === '..') invalid = name
    return encodeURIComponent(segment)
  })
  if (invalid) return failed(`Invalid value for path parameter "${invalid}"`)

  const url = new URL(base.pathname.replace(/\/$/, '') + path, base.origin)
  for (const param of params) {
    const value = args[param.name]
    if (param.in !== 'query' || value === undefined || value === null) continue
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(param.name, queryValue(item))
    else url.searchParams.set(param.name, queryValue(value))
  }
  if (url.origin !== base.origin) return failed('Request left the app origin')

  const token = await appToken(connection, env)
  const headers = new Headers({ Accept: 'application/json' })
  headers.set(...credentialHeader(connection, token))
  // The app can verify this to learn which agent acted; apps that ignore it still work.
  headers.set(ASSERTION_HEADER, await agentAssertion(agent, connection, tool.tool_name, token, env))
  const hasBody = params.some(param => param.in === 'body') && args.body !== undefined
  if (hasBody) headers.set('Content-Type', 'application/json')

  const response = await fetch(url, {
    method: tool.method,
    headers,
    body: hasBody ? JSON.stringify(args.body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(APP_CALL_TIMEOUT_MS),
  })
  if (response.status >= 300 && response.status < 400) return failed('The app answered with a redirect, which is not followed')

  let text = ''
  if (response.body) {
    try { text = await readLimitedText(response, MAX_RESPONSE_BYTES) }
    catch { return failed(`HTTP ${response.status}: the response is larger than ${MAX_RESPONSE_BYTES / 1000} KB. Narrow the request.`) }
  }
  if (!response.ok) return failed(`HTTP ${response.status}${text ? `: ${text.slice(0, 2000)}` : ''}`)
  return { content: [{ type: 'text', text: text || `HTTP ${response.status}` }] }
}
