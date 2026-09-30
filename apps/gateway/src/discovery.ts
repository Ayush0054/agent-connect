import { trustedUrl, type Env } from './core'

export type AppManifest = {
  version: 1
  name: string
  mcp_url: string
  oauth: { authorization_url: string; token_url: string; client_id: string; scope?: string }
}

export async function readSmallJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Empty app manifest')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > 16_384) {
      await reader.cancel()
      throw new Error('App manifest is too large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder().decode(bytes))
}

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
