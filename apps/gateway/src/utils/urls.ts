import type { Env } from '../types/env'

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/**
 * Checks a URL the gateway is about to call on a user's behalf. Only public HTTPS hosts pass,
 * so a connection cannot point the gateway at an internal address. Loopback http:// is allowed
 * only when `ALLOW_LOOPBACK_APPS` is "true" (local development).
 */
export function trustedUrl(value: string, env: Env): string {
  const url = new URL(value)
  if (env.ALLOW_LOOPBACK_APPS === 'true' && url.protocol === 'http:' && isLoopback(url.hostname) && !url.username && !url.password && !url.hash) {
    return url.toString()
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('A public HTTPS URL is required')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || /^[\d.]+$/.test(host) || host.includes(':')) {
    throw new Error('Local and IP addresses are not allowed')
  }
  return url.toString()
}
