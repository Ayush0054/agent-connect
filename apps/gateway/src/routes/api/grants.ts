import { Hono, type Context } from 'hono'
import { listTools } from '../../mcp/tools'
import { getActiveAgent } from '../../stores/agents'
import { getConnection } from '../../stores/connections'
import { deleteGrant, insertGrant } from '../../stores/grants'
import type { Grant, OkResponse, Tool } from '../../types/api'
import type { AppEnv } from '../../types/env'

export const grantRoutes = new Hono<AppEnv>()

/** Reads the request and checks that the agent and the connected app both belong to the signed-in user. */
async function grantTarget(c: Context<AppEnv>) {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body.agent_id !== 'string' || typeof body.connection_id !== 'string' || typeof body.tool_name !== 'string') return null
  const [agent, connection] = await Promise.all([
    getActiveAgent(c.env, body.agent_id, c.get('owner')),
    getConnection(c.env, body.connection_id, c.get('owner')),
  ])
  if (!agent || !connection?.access_token_ciphertext || body.tool_name.length > 255) return null
  const grant: Grant = { agent_id: agent.id, connection_id: connection.id, tool_name: body.tool_name }
  return { connection, grant }
}

grantRoutes.post('/', async c => {
  const target = await grantTarget(c)
  if (!target) return c.json({ error: 'Agent, connection, or tool is invalid' }, 400)
  let tools: Tool[]
  try { tools = await listTools(target.connection, c.env) }
  catch { return c.json({ error: 'Could not verify app tool' }, 502) }
  if (!tools.some(tool => tool.name === target.grant.tool_name)) return c.json({ error: 'App tool not found' }, 404)
  await insertGrant(c.env, target.grant)
  return c.json({ ok: true } satisfies OkResponse)
})

grantRoutes.delete('/', async c => {
  const target = await grantTarget(c)
  if (!target) return c.json({ error: 'Agent, connection, or tool is invalid' }, 400)
  await deleteGrant(c.env, target.grant)
  return c.json({ ok: true } satisfies OkResponse)
})
