import { decrypt, encrypt, execute, first, pkceChallenge, randomString, sha256, trustedUrl, type Connection, type Env } from './core'

type OAuthState = { owner_sub: string; connection_id: string; verifier_ciphertext: string; expires_at: string }
type TokenResponse = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown; error?: unknown }

function dateSql(date: Date): string {
  return date.toISOString().slice(0, 23).replace('T', ' ')
}

export async function startOAuth(connection: Connection, env: Env): Promise<Response> {
  const state = randomString()
  const verifier = randomString(64)
  await execute(env, 'INSERT INTO oauth_states (state_hash, owner_sub, connection_id, verifier_ciphertext, expires_at) VALUES (?, ?, ?, ?, ?)', [
    await sha256(state), connection.owner_sub, connection.id, await encrypt(env, verifier), dateSql(new Date(Date.now() + 10 * 60_000)),
  ])
  const authorize = new URL(trustedUrl(connection.authorization_url, env))
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('client_id', connection.client_id)
  authorize.searchParams.set('redirect_uri', `${env.PUBLIC_BASE_URL}/oauth/callback`)
  authorize.searchParams.set('state', state)
  authorize.searchParams.set('code_challenge', await pkceChallenge(verifier))
  authorize.searchParams.set('code_challenge_method', 'S256')
  authorize.searchParams.set('resource', connection.mcp_url)
  if (connection.scope) authorize.searchParams.set('scope', connection.scope)
  return Response.redirect(authorize, 302)
}

export async function exchangeToken(connection: Connection, env: Env, fields: URLSearchParams): Promise<TokenResponse> {
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
    ? dateSql(new Date(Date.now() + Math.max(0, result.expires_in) * 1000)) : null
  await execute(env, 'UPDATE connections SET access_token_ciphertext = ?, refresh_token_ciphertext = ?, token_expires_at = ?, connected_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [
    await encrypt(env, access), refresh ? await encrypt(env, refresh) : null, expires, connection.id,
  ])
}

export async function oauthCallback(request: Request, owner: string, env: Env): Promise<Response> {
  const query = new URL(request.url).searchParams
  const state = query.get('state')
  const code = query.get('code')
  if (!state || !code) return new Response('OAuth authorization was denied or incomplete', { status: 400 })
  const stateHash = await sha256(state)
  const record = await first<OAuthState>(env, 'SELECT * FROM oauth_states WHERE state_hash = ?', [stateHash])
  if (!record || Date.parse(record.expires_at.replace(' ', 'T') + 'Z') <= Date.now()) return new Response('OAuth state expired', { status: 400 })
  if (owner !== record.owner_sub) return new Response('Account mismatch', { status: 403 })
  const consumed = await execute(env, 'DELETE FROM oauth_states WHERE state_hash = ?', [stateHash])
  if (!consumed.rowsAffected) return new Response('OAuth state already used', { status: 400 })
  const connection = await first<Connection>(env, 'SELECT * FROM connections WHERE id = ? AND owner_sub = ?', [record.connection_id, owner])
  if (!connection) return new Response('Connection not found', { status: 404 })
  const fields = new URLSearchParams({
    grant_type: 'authorization_code', code, client_id: connection.client_id,
    code_verifier: await decrypt(env, record.verifier_ciphertext),
    redirect_uri: `${env.PUBLIC_BASE_URL}/oauth/callback`,
    resource: connection.mcp_url,
  })
  try {
    await saveTokens(connection, env, await exchangeToken(connection, env, fields))
  } catch {
    return new Response('App OAuth token request failed. Start the connection again.', { status: 502 })
  }
  return Response.redirect(`${env.PUBLIC_BASE_URL}/?connected=${encodeURIComponent(connection.id)}`, 302)
}

export async function appToken(connection: Connection, env: Env): Promise<string> {
  if (!connection.access_token_ciphertext) throw new Error('App is not connected')
  const expires = connection.token_expires_at ? Date.parse(connection.token_expires_at.replace(' ', 'T') + 'Z') : Infinity
  if (expires > Date.now() + 60_000) return decrypt(env, connection.access_token_ciphertext)
  if (!connection.refresh_token_ciphertext) throw new Error('App authorization expired')
  const refresh = await decrypt(env, connection.refresh_token_ciphertext)
  const fields = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: connection.client_id, resource: connection.mcp_url })
  const result = await exchangeToken(connection, env, fields)
  await saveTokens(connection, env, result, refresh)
  return String(result.access_token)
}
