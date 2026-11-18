import { Hono } from 'hono'
import { insertAgent, revokeAgent } from '../../stores/agents'
import type { CreateAgentResponse, OkResponse } from '../../types/api'
import type { AppEnv } from '../../types/env'
import { randomString, sha256 } from '../../utils/crypto'

export const agentRoutes = new Hono<AppEnv>()

agentRoutes.post('/', async c => {
  const body = await c.req.json().catch(() => null) as { name?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 100) return c.json({ error: 'Name must be 1–100 characters' }, 400)
  const id = crypto.randomUUID()
  const token = `ac_${randomString(32)}`
  await insertAgent(c.env, { id, owner: c.get('owner'), name, tokenHash: await sha256(token) })
  return c.json({ id, name, token, mcp_url: `${c.env.MCP_BASE_URL}/mcp` } satisfies CreateAgentResponse, 201)
})

agentRoutes.post('/:id/revoke', async c => {
  if (!await revokeAgent(c.env, c.req.param('id'), c.get('owner'))) return c.json({ error: 'Agent not found' }, 404)
  return c.json({ ok: true } satisfies OkResponse)
})
