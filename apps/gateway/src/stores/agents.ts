import type { Agent } from '../types/agents'
import type { AgentSummary } from '../types/api'
import type { Env } from '../types/env'
import { execute, first, rows } from './db'

export function listAgents(env: Env, owner: string): Promise<AgentSummary[]> {
  return rows(env, 'SELECT id, name, created_at, revoked_at FROM agents WHERE owner_sub = $1 ORDER BY created_at DESC', [owner])
}

export function listActiveAgents(env: Env, owner: string): Promise<Pick<Agent, 'id' | 'name'>[]> {
  return rows(env, 'SELECT id, name FROM agents WHERE owner_sub = $1 AND revoked_at IS NULL ORDER BY created_at DESC', [owner])
}

/** An agent of this owner that has not been revoked. */
export function getActiveAgent(env: Env, id: string, owner: string): Promise<Agent | null> {
  return first(env, 'SELECT * FROM agents WHERE id = $1 AND owner_sub = $2 AND revoked_at IS NULL', [id, owner])
}

export function getActiveAgentById(env: Env, id: string): Promise<Agent | null> {
  return first(env, 'SELECT * FROM agents WHERE id = $1 AND revoked_at IS NULL', [id])
}

/** The agent a bearer token belongs to: a token pasted from the control plane, or an OAuth access token of an MCP host. */
export async function findAgentByTokenHash(env: Env, tokenHash: string): Promise<Agent | null> {
  const agent = await first<Agent>(env, 'SELECT * FROM agents WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash])
  if (agent) return agent
  return first<Agent>(env,
    "SELECT a.* FROM agent_tokens t JOIN agents a ON a.id = t.agent_id WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > $2 AND a.revoked_at IS NULL",
    [tokenHash, new Date().toISOString()])
}

/** `tokenHash` is null for agents created on the consent page, which only use OAuth tokens. */
export async function insertAgent(env: Env, agent: { id: string; owner: string; name: string; tokenHash: string | null }): Promise<void> {
  await execute(env, 'INSERT INTO agents (id, owner_sub, name, token_hash) VALUES ($1, $2, $3, $4)', [agent.id, agent.owner, agent.name, agent.tokenHash])
}

/** Returns false when the agent does not exist, belongs to someone else, or is already revoked. */
export async function revokeAgent(env: Env, id: string, owner: string): Promise<boolean> {
  const result = await execute(env, 'UPDATE agents SET revoked_at = now() WHERE id = $1 AND owner_sub = $2 AND revoked_at IS NULL', [id, owner])
  return result.rowCount > 0
}
