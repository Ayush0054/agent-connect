// /api: the control-plane API used by `apps/web`. Request and response shapes are in `types/api.ts`.
import { Hono } from 'hono'
import { listRecentActions } from '../../stores/actionLog'
import { listAgents } from '../../stores/agents'
import { listConnectionSummaries } from '../../stores/connections'
import { listGrantsForOwner } from '../../stores/grants'
import type { OverviewResponse } from '../../types/api'
import type { AppEnv } from '../../types/env'
import { agentRoutes } from './agents'
import { connectionRoutes } from './connections'
import { grantRoutes } from './grants'

export const apiRoutes = new Hono<AppEnv>()

apiRoutes.get('/overview', async c => {
  const owner = c.get('owner')
  const [agents, connections, grants, actions] = await Promise.all([
    listAgents(c.env, owner),
    listConnectionSummaries(c.env, owner),
    listGrantsForOwner(c.env, owner),
    listRecentActions(c.env, owner),
  ])
  return c.json({ agents, connections, grants, actions, mcp_url: `${c.env.MCP_BASE_URL}/mcp` } satisfies OverviewResponse)
})

apiRoutes.route('/agents', agentRoutes)
apiRoutes.route('/connections', connectionRoutes)
apiRoutes.route('/grants', grantRoutes)
