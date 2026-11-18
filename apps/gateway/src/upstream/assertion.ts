// A short-lived signed JWT sent with every call to an app, so the app can verify which agent is acting.
// Apps check it against the public keys at /.well-known/agent-connect/jwks.json.
import { importJWK, SignJWT } from 'jose'
import type { Agent } from '../types/agents'
import type { Connection } from '../types/connections'
import type { Env } from '../types/env'
import { sha256Base64url } from '../utils/crypto'

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

/** Valid for 60 seconds, for one tool, and only together with the app token whose hash is in `ath`. */
export async function agentAssertion(agent: Agent, connection: Connection, toolName: string, appAccessToken: string, env: Env): Promise<string> {
  const jwk = signingJwk(env)
  const key = await importJWK(jwk, 'ES256')
  return new SignJWT({
    connection_id: connection.id,
    owner_sub: agent.owner_sub,
    agent_name: agent.name,
    tool_name: toolName,
    ath: await sha256Base64url(appAccessToken),
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
