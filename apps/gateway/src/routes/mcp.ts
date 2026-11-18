// /mcp: the one endpoint MCP hosts talk to. Served on the MCP origin, authenticated by an agent token.
import { Hono } from 'hono'
import { resourceMetadataUrl } from '../hostAuth/authorize'
import { serveMcp } from '../mcp/server'
import { findAgentByTokenHash } from '../stores/agents'
import type { AppEnv } from '../types/env'
import { sha256 } from '../utils/crypto'

export const mcpRoutes = new Hono<AppEnv>()

mcpRoutes.all('/', async c => {
  if (new URL(c.req.url).host !== new URL(c.env.MCP_BASE_URL).host) return c.text('Invalid host', 400)
  const origin = c.req.header('Origin')
  if (origin && origin !== new URL(c.env.MCP_BASE_URL).origin) return c.text('Invalid origin', 403)

  const header = c.req.header('Authorization')
  const agent = header?.startsWith('Bearer ac_') ? await findAgentByTokenHash(c.env, await sha256(header.slice(7))) : null
  // The 401 tells the host where to find the OAuth metadata, which starts the sign-in.
  if (!agent) return c.text('Unauthorized', 401, { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(c.env)}"` })
  return serveMcp(c.req.raw, agent, c.env)
})
