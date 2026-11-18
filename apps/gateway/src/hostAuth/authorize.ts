// Agent Connect's own OAuth server, used by MCP hosts (Claude Code, Codex, Cursor, SDK clients).
// A host adds the MCP URL, receives a 401 pointing at our metadata, registers (dynamic client
// registration or a client ID metadata document), and sends the user to a consent page where
// they pick or create an agent and choose its tools. The resulting tokens are bound to that
// agent; revoking the agent revokes them. The HTTP routes are in `routes/oauth.ts`.
import { ACCESS_TTL_SECONDS, HOST_SCOPE, REFRESH_TTL_SECONDS } from '../constants'
import { getHostClient, insertAgentTokens } from '../stores/hostAuth'
import type { Env } from '../types/env'
import type { AuthorizeParams, HostClient, HostTokenResponse } from '../types/hostAuth'
import { randomString, sha256 } from '../utils/crypto'
import { readSmallJson } from '../utils/http'
import { isLoopback, trustedUrl } from '../utils/urls'

export const issuer = (env: Env) => new URL(env.MCP_BASE_URL).origin
export const mcpResource = (env: Env) => `${issuer(env)}/mcp`
export const resourceMetadataUrl = (env: Env) => `${issuer(env)}/.well-known/oauth-protected-resource/mcp`

/** https, http on loopback (RFC 8252 native apps), or a private-use scheme such as cursor://. */
export function allowedRedirect(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.hash || url.username || url.password) return false
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') return isLoopback(url.hostname)
  return !['javascript:', 'data:', 'file:', 'blob:', 'vbscript:', 'about:'].includes(url.protocol)
}

/** Exact match, except loopback redirects may use any port (RFC 8252 §7.3). */
function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true
  let wanted: URL
  try { wanted = new URL(requested) } catch { return false }
  if (wanted.protocol !== 'http:' || !isLoopback(wanted.hostname)) return false
  return registered.some(value => {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === wanted.hostname && url.pathname === wanted.pathname && url.search === wanted.search
  })
}

async function resolveClient(clientId: string, env: Env): Promise<HostClient | null> {
  if (clientId.startsWith('https://')) {
    // Client ID metadata document: the client_id is a URL serving the client's metadata.
    try {
      const response = await fetch(trustedUrl(clientId, env), { headers: { Accept: 'application/json' }, redirect: 'manual' })
      if (!response.ok) return null
      const doc = await readSmallJson(response) as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown }
      if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every(allowedRedirect)) return null
      const name = typeof doc.client_name === 'string' && doc.client_name.trim() ? doc.client_name.trim().slice(0, 100) : new URL(clientId).hostname
      return { client_id: clientId, client_name: name, redirect_uris: doc.redirect_uris, metadataDocument: true }
    } catch { return null }
  }
  const row = await getHostClient(env, clientId)
  return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[], metadataDocument: false } : null
}

/** Validates an authorization request. Errors before the redirect URI is trusted are shown, not redirected. */
export async function authorizeParams(params: Record<string, string | undefined>, env: Env): Promise<{ ok: AuthorizeParams } | { page: string } | { redirect: string }> {
  const client = params.client_id ? await resolveClient(params.client_id, env) : null
  if (!client) return { page: 'Unknown client. The MCP host must register with Agent Connect first.' }
  const redirectUri = params.redirect_uri ?? ''
  if (!redirectMatches(client.redirect_uris, redirectUri)) return { page: 'This redirect URI is not registered for the client.' }
  const fail = (error: string) => {
    const target = new URL(redirectUri)
    target.searchParams.set('error', error)
    if (params.state) target.searchParams.set('state', params.state)
    target.searchParams.set('iss', issuer(env))
    return { redirect: target.toString() }
  }
  if (params.response_type !== 'code') return fail('unsupported_response_type')
  if (params.code_challenge_method !== 'S256' || !params.code_challenge || params.code_challenge.length > 128) return fail('invalid_request')
  if (params.resource && params.resource.replace(/\/$/, '') !== mcpResource(env)) return fail('invalid_target')
  return { ok: { client, redirectUri, state: params.state ?? '', codeChallenge: params.code_challenge } }
}

/** A new access and refresh token for an agent. Only their hashes are stored. */
export async function issueTokens(env: Env, agentId: string, clientId: string): Promise<HostTokenResponse> {
  const access = `ac_${randomString(32)}`
  const refresh = `acr_${randomString(32)}`
  const now = Date.now()
  await insertAgentTokens(env, agentId, clientId,
    { tokenHash: await sha256(access), expiresAt: new Date(now + ACCESS_TTL_SECONDS * 1000).toISOString() },
    { tokenHash: await sha256(refresh), expiresAt: new Date(now + REFRESH_TTL_SECONDS * 1000).toISOString() })
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: HOST_SCOPE }
}
