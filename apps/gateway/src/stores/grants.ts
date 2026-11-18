import type { Agent, Grant } from '../types/agents'
import type { Env } from '../types/env'
import { execute, first, rows } from './db'

export function listGrantsForOwner(env: Env, owner: string): Promise<Grant[]> {
  return rows(env, 'SELECT g.agent_id, g.connection_id, g.tool_name FROM grants g JOIN agents a ON a.id = g.agent_id WHERE a.owner_sub = $1', [owner])
}

/** Grants of one agent, limited to connections of the agent's owner. */
export function listGrantsForAgent(env: Env, agent: Agent): Promise<Grant[]> {
  return rows(env,
    'SELECT g.agent_id, g.connection_id, g.tool_name FROM grants g JOIN connections c ON c.id = g.connection_id WHERE g.agent_id = $1 AND c.owner_sub = $2',
    [agent.id, agent.owner_sub])
}

/** Checked again on every tool call, so a revoke takes effect on the next call. */
export async function hasGrant(env: Env, agent: Agent, connectionId: string, toolName: string): Promise<boolean> {
  const found = await first<Grant>(env,
    'SELECT g.agent_id, g.connection_id, g.tool_name FROM grants g JOIN agents a ON a.id = g.agent_id JOIN connections c ON c.id = g.connection_id WHERE g.agent_id = $1 AND g.connection_id = $2 AND g.tool_name = $3 AND a.revoked_at IS NULL AND a.owner_sub = c.owner_sub AND c.owner_sub = $4',
    [agent.id, connectionId, toolName, agent.owner_sub])
  return Boolean(found)
}

export async function insertGrant(env: Env, grant: Grant): Promise<void> {
  await execute(env, 'INSERT INTO grants (agent_id, connection_id, tool_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [grant.agent_id, grant.connection_id, grant.tool_name])
}

export async function deleteGrant(env: Env, grant: Grant): Promise<void> {
  await execute(env, 'DELETE FROM grants WHERE agent_id = $1 AND connection_id = $2 AND tool_name = $3', [grant.agent_id, grant.connection_id, grant.tool_name])
}

export async function deleteGrantsForConnection(env: Env, connectionId: string): Promise<void> {
  await execute(env, 'DELETE FROM grants WHERE connection_id = $1', [connectionId])
}

/** After a spec re-import: remove grants for operations that no longer exist. */
export async function deleteGrantsForMissingTools(env: Env, connectionId: string): Promise<void> {
  await execute(env, 'DELETE FROM grants g WHERE g.connection_id = $1 AND NOT EXISTS (SELECT 1 FROM connection_tools t WHERE t.connection_id = g.connection_id AND t.tool_name = g.tool_name)', [connectionId])
}
