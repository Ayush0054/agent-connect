// Protects the control plane (web app, /api, consent page). The user is identified by Cloudflare Access.
import type { MiddlewareHandler } from 'hono'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { AppEnv, Env } from '../types/env'
import { isLoopback } from '../utils/urls'

/** The signed-in user's ID from the Cloudflare Access JWT, or `DEV_OWNER` in local development. */
async function accessOwner(request: Request, env: Env): Promise<string | null> {
  const base = new URL(env.PUBLIC_BASE_URL)
  if (env.DEV_OWNER && base.protocol === 'http:' && isLoopback(base.hostname)) return env.DEV_OWNER
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!assertion) return null
  const issuer = env.ACCESS_ISSUER.replace(/\/$/, '')
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
  try {
    const { payload } = await jwtVerify(assertion, jwks, { issuer, audience: env.ACCESS_AUD })
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

/** Requires the admin host and a signed-in user, and blocks cross-site writes. Sets `owner` for the routes. */
export const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (new URL(c.req.url).host !== new URL(c.env.PUBLIC_BASE_URL).host) return c.text('Invalid host', 400)
  const owner = await accessOwner(c.req.raw, c.env)
  if (!owner) return c.text('Cloudflare Access authentication required', 401)
  const method = c.req.method
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = c.req.header('Origin')
    const adminOrigin = new URL(c.env.PUBLIC_BASE_URL).origin
    if (new URL(c.req.url).pathname === '/oauth/authorize') {
      // The host consent page is a plain HTML form, so require a same-origin Origin header instead of JSON.
      if (origin !== adminOrigin) return c.text('Invalid origin', 403)
    } else {
      if (origin && origin !== adminOrigin) return c.text('Invalid origin', 403)
      if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.text('JSON body required', 415)
    }
  }
  c.set('owner', owner)
  await next()
}
