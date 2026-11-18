import { Hono } from 'hono'
import { adminAuth } from './middleware/adminAuth'
import { apiRoutes } from './routes/api/index'
import { healthRoutes } from './routes/health'
import { mcpRoutes } from './routes/mcp'
import { oauthRoutes } from './routes/oauth'
import { wellKnownRoutes } from './routes/wellKnown'
import type { AppEnv } from './types/env'

export function createApp() {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    await next()
    if (new URL(c.req.url).pathname !== '/.well-known/agent-connect/jwks.json') c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Content-Type-Options', 'nosniff')
  })

  app.onError((error, c) => {
    console.error('Request failed:', error.name, error.message)
    return c.json({ error: 'Request failed' }, 500)
  })

  // Public and agent-facing routes, on the MCP origin.
  app.route('/', healthRoutes)
  app.route('/.well-known', wellKnownRoutes)
  app.route('/mcp', mcpRoutes)

  // Control plane, on the admin origin behind Cloudflare Access.
  app.use('/', adminAuth)
  app.use('/assets/*', adminAuth)
  app.use('/api/*', adminAuth)
  app.use('/oauth/callback', adminAuth)
  app.use('/oauth/authorize', adminAuth)

  app.route('/oauth', oauthRoutes)
  app.route('/api', apiRoutes)

  // The built web app (`apps/web/dist`).
  app.get('/', c => c.env.ASSETS.fetch(c.req.raw))
  app.get('/assets/*', c => c.env.ASSETS.fetch(c.req.raw))

  return app
}
