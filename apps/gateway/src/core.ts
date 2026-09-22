import { connect } from '@planetscale/database'
import { createRemoteJWKSet, jwtVerify } from 'jose'

export type Env = {
  DATABASE_HOST: string
  DATABASE_USERNAME: string
  DATABASE_PASSWORD: string
  ENCRYPTION_KEY: string
  ASSERTION_PRIVATE_JWK: string
  ASSETS: { fetch(request: Request): Promise<Response> }
  PUBLIC_BASE_URL: string
  MCP_BASE_URL: string
  ACCESS_ISSUER: string
  ACCESS_AUD: string
}

export type Agent = { id: string; owner_sub: string; name: string; token_hash: string; revoked_at: string | null; created_at: string }
export type Connection = {
  id: string
  owner_sub: string
  name: string
  mcp_url: string
  authorization_url: string
  token_url: string
  client_id: string
  scope: string
  access_token_ciphertext: string | null
  refresh_token_ciphertext: string | null
  token_expires_at: string | null
  connected_at: string | null
}
export type Grant = { agent_id: string; connection_id: string; tool_name: string }

export function db(env: Env) {
  return connect({ host: env.DATABASE_HOST, username: env.DATABASE_USERNAME, password: env.DATABASE_PASSWORD })
}

export async function rows<T>(env: Env, sql: string, params: Array<string | number | null> = []): Promise<T[]> {
  const result = await db(env).execute(sql, params)
  return result.rows as T[]
}

export async function first<T>(env: Env, sql: string, params: Array<string | number | null> = []): Promise<T | null> {
  return (await rows<T>(env, sql, params))[0] ?? null
}

export async function execute(env: Env, sql: string, params: Array<string | number | null> = []) {
  return db(env).execute(sql, params)
}

export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

export async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return base64url(bytes)
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const raw = fromBase64url(env.ENCRYPTION_KEY)
  if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must contain 32 bytes')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encrypt(env: Env, value: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await encryptionKey(env), new TextEncoder().encode(value)))
  const output = new Uint8Array(nonce.length + encrypted.length)
  output.set(nonce)
  output.set(encrypted, nonce.length)
  return base64url(output)
}

export async function decrypt(env: Env, value: string): Promise<string> {
  const bytes = fromBase64url(value)
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await encryptionKey(env), bytes.slice(12))
  return new TextDecoder().decode(clear)
}

export async function accessOwner(request: Request, env: Env): Promise<string | null> {
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!assertion) return null
  const issuer = env.ACCESS_ISSUER.replace(/\/$/, '')
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
  try {
    const { payload } = await jwtVerify(assertion, jwks, { issuer, audience: env.ACCESS_AUD })
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

export function trustedUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('A public HTTPS URL is required')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || /^[\d.]+$/.test(host) || host.includes(':')) {
    throw new Error('Local and IP addresses are not allowed')
  }
  return url.toString()
}

export async function agentFromBearer(request: Request, env: Env): Promise<Agent | null> {
  const header = request.headers.get('Authorization')
  if (!header?.startsWith('Bearer ac_')) return null
  const hash = await sha256(header.slice(7))
  return first<Agent>(env, 'SELECT * FROM agents WHERE token_hash = ? AND revoked_at IS NULL', [hash])
}
