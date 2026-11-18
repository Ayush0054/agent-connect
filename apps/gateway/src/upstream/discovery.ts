// Read the manifest an MCP app publishes at /.well-known/agent-connect.json.
import type { AppManifest } from '../types/connections'
import type { Env } from '../types/env'
import { readSmallJson } from '../utils/http'
import { trustedUrl } from '../utils/urls'

export async function discoverApp(appUrl: string, env: Env): Promise<AppManifest> {
  const origin = new URL(trustedUrl(appUrl, env)).origin
  const endpoint = new URL('/.well-known/agent-connect.json', origin)
  const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, redirect: 'manual' })
  if (!response.ok) throw new Error('App discovery failed')
  const data = await readSmallJson(response) as Partial<AppManifest>
  if (data.version !== 1 || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 100 ||
      typeof data.mcp_url !== 'string' || !data.oauth || typeof data.oauth !== 'object' ||
      typeof data.oauth.authorization_url !== 'string' || typeof data.oauth.token_url !== 'string' ||
      typeof data.oauth.client_id !== 'string' || !data.oauth.client_id || data.oauth.client_id.length > 2048 ||
      (data.oauth.scope !== undefined && (typeof data.oauth.scope !== 'string' || data.oauth.scope.length > 2048))) {
    throw new Error('Invalid app manifest')
  }
  return {
    version: 1,
    name: data.name.trim(),
    mcp_url: trustedUrl(data.mcp_url, env),
    oauth: {
      authorization_url: trustedUrl(data.oauth.authorization_url, env),
      token_url: trustedUrl(data.oauth.token_url, env),
      client_id: data.oauth.client_id,
      scope: data.oauth.scope ?? '',
    },
  }
}
