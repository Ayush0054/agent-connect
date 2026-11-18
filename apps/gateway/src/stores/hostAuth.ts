// Storage for the gateway's own OAuth server: registered MCP hosts, authorization codes and agent tokens.
// Codes and tokens are stored as hashes.
import type { AgentToken, AuthCode, StoredHostClient } from '../types/hostAuth'
import type { Env } from '../types/env'
import { execute, first } from './db'

export function getHostClient(env: Env, clientId: string): Promise<StoredHostClient | null> {
  return first(env, 'SELECT * FROM oauth_clients WHERE client_id = $1', [clientId])
}

export async function insertHostClient(env: Env, client: { clientId: string; name: string; redirectUris: string[] }): Promise<void> {
  await execute(env, 'INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)', [client.clientId, client.name, JSON.stringify(client.redirectUris)])
}

export async function insertAuthCode(env: Env, code: { codeHash: string; clientId: string; agentId: string; redirectUri: string; codeChallenge: string; expiresAt: string }): Promise<void> {
  await execute(env, 'INSERT INTO host_auth_codes (code_hash, client_id, agent_id, redirect_uri, code_challenge, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [
    code.codeHash, code.clientId, code.agentId, code.redirectUri, code.codeChallenge, code.expiresAt,
  ])
}

export function getAuthCode(env: Env, codeHash: string): Promise<AuthCode | null> {
  return first(env, 'SELECT * FROM host_auth_codes WHERE code_hash = $1', [codeHash])
}

/** Returns false when another request already used the code. */
export async function consumeAuthCode(env: Env, codeHash: string): Promise<boolean> {
  const result = await execute(env, 'DELETE FROM host_auth_codes WHERE code_hash = $1', [codeHash])
  return result.rowCount > 0
}

type NewToken = { tokenHash: string; expiresAt: string }

export async function insertAgentTokens(env: Env, agentId: string, clientId: string, access: NewToken, refresh: NewToken): Promise<void> {
  await execute(env, 'INSERT INTO agent_tokens (token_hash, agent_id, client_id, kind, expires_at) VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)', [
    access.tokenHash, agentId, clientId, 'access', access.expiresAt,
    refresh.tokenHash, agentId, clientId, 'refresh', refresh.expiresAt,
  ])
}

export function getRefreshToken(env: Env, tokenHash: string): Promise<AgentToken | null> {
  return first(env, "SELECT agent_id, client_id, expires_at FROM agent_tokens WHERE token_hash = $1 AND kind = 'refresh'", [tokenHash])
}

/** Returns false when another request already used the token. */
export async function consumeAgentToken(env: Env, tokenHash: string): Promise<boolean> {
  const result = await execute(env, 'DELETE FROM agent_tokens WHERE token_hash = $1', [tokenHash])
  return result.rowCount > 0
}
