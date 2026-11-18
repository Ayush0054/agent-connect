import type { ActionOutcome, Agent } from '../types/agents'
import type { ActionSummary } from '../types/api'
import type { Env } from '../types/env'
import { execute, rows } from './db'

export async function recordAction(env: Env, agent: Agent, connectionId: string, toolName: string, outcome: ActionOutcome): Promise<void> {
  await execute(env, 'INSERT INTO action_log (id, agent_id, connection_id, tool_name, outcome) VALUES ($1, $2, $3, $4, $5)', [
    crypto.randomUUID(), agent.id, connectionId, toolName, outcome,
  ])
}

export function listRecentActions(env: Env, owner: string): Promise<ActionSummary[]> {
  return rows(env,
    'SELECT l.id, l.agent_id, l.connection_id, l.tool_name, l.outcome, l.created_at FROM action_log l JOIN agents a ON a.id = l.agent_id WHERE a.owner_sub = $1 ORDER BY l.created_at DESC LIMIT 30', [owner])
}
