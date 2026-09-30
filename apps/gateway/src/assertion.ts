import { importJWK, SignJWT } from 'jose'
import type { Agent, Connection, Env } from './core'

type SigningJwk = { kty: string; crv: string; x: string; y: string; d: string; kid?: string }

function signingJwk(env: Env): SigningJwk {
  const key = JSON.parse(env.ASSERTION_PRIVATE_JWK) as Partial<SigningJwk>
  if (key.kty !== 'EC' || key.crv !== 'P-256' || !key.x || !key.y || !key.d) {
    throw new Error('ASSERTION_PRIVATE_JWK must be a P-256 private JWK')
  }
  return key as SigningJwk
}

export function publicJwks(env: Env) {
  const { kty, crv, x, y, kid } = signingJwk(env)
  return { keys: [{ kty, crv, x, y, kid: kid ?? 'current', alg: 'ES256', use: 'sig' }] }
}

function base64url(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return base64url(new Uint8Array(digest))
}

export async function agentAssertion(agent: Agent, connection: Connection, toolName: string, appAccessToken: string, env: Env): Promise<string> {
  const jwk = signingJwk(env)
  const key = await importJWK(jwk, 'ES256')
  return new SignJWT({
    connection_id: connection.id,
    owner_sub: agent.owner_sub,
    agent_name: agent.name,
    tool_name: toolName,
    ath: await tokenHash(appAccessToken),
  })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid ?? 'current', typ: 'JWT' })
    .setIssuer(env.MCP_BASE_URL)
    .setAudience(connection.mcp_url)
    .setSubject(agent.id)
    .setIssuedAt()
    .setExpirationTime('60s')
    .setJti(crypto.randomUUID())
    .sign(key)
}
