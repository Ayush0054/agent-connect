// The gateway as an OAuth client of a connected app: send the user to the app to sign in,
// exchange the code, keep the tokens encrypted, and refresh them when they expire.
import { OAUTH_STATE_TTL_MS } from '../constants'
import { getConnection, saveConnectionTokens } from '../stores/connections'
import { consumeOAuthState, getOAuthState, insertOAuthState } from '../stores/oauthStates'
import type { Connection, TokenResponse } from '../types/connections'
import type { Env } from '../types/env'
import { decrypt, encrypt, pkceChallenge, randomString, sha256 } from '../utils/crypto'
import { trustedUrl } from '../utils/urls'

export async function startOAuth(connection: Connection, env: Env): Promise<Response> {
  const state = randomString()
  const verifier = randomString(64)
  await insertOAuthState(env, {
    stateHash: await sha256(state),
    owner: connection.owner_sub,
    connectionId: connection.id,
    verifierCiphertext: await encrypt(env, verifier),
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
  })
  const authorize = new URL(trustedUrl(connection.authorization_url, env))
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('client_id', connection.client_id)
  authorize.searchParams.set('redirect_uri', `${env.PUBLIC_BASE_URL}/oauth/callback`)
  authorize.searchParams.set('state', state)
  authorize.searchParams.set('code_challenge', await pkceChallenge(verifier))
  authorize.searchParams.set('code_challenge_method', 'S256')
  // RFC 8707 resource indicators are an MCP requirement; plain REST apps often reject unknown parameters.
  if (connection.kind === 'mcp') authorize.searchParams.set('resource', connection.mcp_url)
  if (connection.scope) authorize.searchParams.set('scope', connection.scope)
  return Response.redirect(authorize, 302)
}

async function exchangeToken(connection: Connection, env: Env, fields: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(trustedUrl(connection.token_url, env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: fields,
    redirect: 'manual',
  })
  const body = await response.json().catch(() => null) as TokenResponse | null
  if (!response.ok || !body || typeof body.access_token !== 'string' || body.token_type?.toString().toLowerCase() !== 'bearer') {
    throw new Error('App OAuth token request failed')
  }
  return body
}

async function saveTokens(connection: Connection, env: Env, result: TokenResponse, previousRefresh?: string) {
  const access = String(result.access_token)
  const refresh = typeof result.refresh_token === 'string' ? result.refresh_token : previousRefresh
  const expires = typeof result.expires_in === 'number' && Number.isFinite(result.expires_in)
    ? new Date(Date.now() + Math.max(0, result.expires_in) * 1000).toISOString() : null
  await saveConnectionTokens(env, connection.id, {
    accessCiphertext: await encrypt(env, access),
    refreshCiphertext: refresh ? await encrypt(env, refresh) : null,
    expiresAt: expires,
  })
}

/** The app sends the user back here after sign-in. */
export async function oauthCallback(request: Request, owner: string, env: Env): Promise<Response> {
  const query = new URL(request.url).searchParams
  const state = query.get('state')
  const code = query.get('code')
  if (!state || !code) return new Response('OAuth authorization was denied or incomplete', { status: 400 })
  const stateHash = await sha256(state)
  const record = await getOAuthState(env, stateHash)
  if (!record || record.expires_at.getTime() <= Date.now()) return new Response('OAuth state expired', { status: 400 })
  if (owner !== record.owner_sub) return new Response('Account mismatch', { status: 403 })
  if (!await consumeOAuthState(env, stateHash)) return new Response('OAuth state already used', { status: 400 })
  const connection = await getConnection(env, record.connection_id, owner)
  if (!connection) return new Response('Connection not found', { status: 404 })
  const fields = new URLSearchParams({
    grant_type: 'authorization_code', code, client_id: connection.client_id,
    code_verifier: await decrypt(env, record.verifier_ciphertext),
    redirect_uri: `${env.PUBLIC_BASE_URL}/oauth/callback`,
  })
  if (connection.kind === 'mcp') fields.set('resource', connection.mcp_url)
  try {
    await saveTokens(connection, env, await exchangeToken(connection, env, fields))
  } catch {
    return new Response('App OAuth token request failed. Start the connection again.', { status: 502 })
  }
  return Response.redirect(`${env.PUBLIC_BASE_URL}/?connected=${encodeURIComponent(connection.id)}`, 302)
}

/** The credential to send to the app: the stored API key, or an OAuth access token that is refreshed when it is about to expire. */
export async function appToken(connection: Connection, env: Env): Promise<string> {
  if (!connection.access_token_ciphertext) throw new Error('App is not connected')
  if (connection.auth_kind === 'api_key') return decrypt(env, connection.access_token_ciphertext)
  const expires = connection.token_expires_at ? connection.token_expires_at.getTime() : Infinity
  if (expires > Date.now() + 60_000) return decrypt(env, connection.access_token_ciphertext)
  if (!connection.refresh_token_ciphertext) throw new Error('App authorization expired')
  const refresh = await decrypt(env, connection.refresh_token_ciphertext)
  const fields = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: connection.client_id })
  if (connection.kind === 'mcp') fields.set('resource', connection.mcp_url)
  const result = await exchangeToken(connection, env, fields)
  await saveTokens(connection, env, result, refresh)
  return String(result.access_token)
}
