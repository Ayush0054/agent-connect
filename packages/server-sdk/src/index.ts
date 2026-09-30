import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

export type AgentConnectIntegrationConfig = {
  name: string
  mcpUrl: string
  oauth: {
    authorizationUrl: string
    tokenUrl: string
    clientId: string
    scope?: string
  }
  /** The trusted Agent Connect MCP origin, e.g. https://mcp.connect.example.com. */
  gatewayIssuer: string
  /** Verify this application's OAuth access token and return its local user ID. */
  verifyAccessToken: (token: string, request: Request) => Promise<{ userId: string } | null>
  /** Optional app-side per-agent or per-tool policy. */
  authorizeAgent?: (context: AgentContext) => Promise<boolean>
}

export type AgentContext = {
  appUserId: string
  agentId: string
  /** Display name the user gave this agent in Agent Connect. */
  agentName?: string
  gatewayOwnerId: string
  connectionId: string
  toolName: string
}

export class AgentConnectAuthError extends Error {
  constructor(message: string, readonly status: 401 | 403 = 401) {
    super(message)
    this.name = 'AgentConnectAuthError'
  }
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

/** HTTPS, or plain HTTP on a loopback host for local development. */
function httpsUrl(value: string): string {
  const url = new URL(value)
  const localHttp = url.protocol === 'http:' && loopbackHosts.has(url.hostname)
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.hash) throw new Error('Expected an HTTPS URL')
  return url.toString()
}

function base64url(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function accessTokenHash(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return base64url(bytes)
}

function equalHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

export function createAgentConnectIntegration(config: AgentConnectIntegrationConfig) {
  if (!config.name.trim() || !config.oauth.clientId.trim()) throw new Error('Name and public OAuth client ID are required')
  const mcpUrl = httpsUrl(config.mcpUrl)
  const authorizationUrl = httpsUrl(config.oauth.authorizationUrl)
  const tokenUrl = httpsUrl(config.oauth.tokenUrl)
  const issuer = new URL(httpsUrl(config.gatewayIssuer)).origin
  const jwks = createRemoteJWKSet(new URL('/.well-known/agent-connect/jwks.json', issuer))

  return {
    /** Mount at GET /.well-known/agent-connect.json on the app service origin. */
    discoveryResponse(): Response {
      return Response.json({
        version: 1,
        name: config.name,
        mcp_url: mcpUrl,
        oauth: {
          authorization_url: authorizationUrl,
          token_url: tokenUrl,
          client_id: config.oauth.clientId,
          scope: config.oauth.scope ?? '',
        },
      }, { headers: { 'Cache-Control': 'public, max-age=300' } })
    },

    /** Call inside an app MCP tool handler using that handler's raw HTTP request. */
    async verifyToolCall(request: Request, toolName: string): Promise<AgentContext> {
      const authorization = request.headers.get('Authorization')
      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
      const assertion = request.headers.get('Agent-Connect-Assertion')
      if (!token || !assertion || !toolName) throw new AgentConnectAuthError('Missing app token or agent assertion')

      const appUser = await config.verifyAccessToken(token, request)
      if (!appUser?.userId) throw new AgentConnectAuthError('Invalid app access token')

      let payload: JWTPayload
      try {
        ({ payload } = await jwtVerify(assertion, jwks, {
          issuer,
          audience: mcpUrl,
          algorithms: ['ES256'],
          clockTolerance: 5,
          requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'jti'],
        }))
      } catch { throw new AgentConnectAuthError('Invalid agent assertion') }

      const age = Math.floor(Date.now() / 1000) - Number(payload.iat)
      if (age < -5 || age > 65 || typeof payload.sub !== 'string' ||
          typeof payload.owner_sub !== 'string' || typeof payload.connection_id !== 'string' ||
          payload.tool_name !== toolName || typeof payload.ath !== 'string' ||
          !equalHash(payload.ath, await accessTokenHash(token))) {
        throw new AgentConnectAuthError('Agent assertion does not match this tool call')
      }

      const context: AgentContext = {
        appUserId: appUser.userId,
        agentId: payload.sub,
        agentName: typeof payload.agent_name === 'string' ? payload.agent_name : undefined,
        gatewayOwnerId: payload.owner_sub,
        connectionId: payload.connection_id,
        toolName,
      }
      if (config.authorizeAgent && !await config.authorizeAgent(context)) {
        throw new AgentConnectAuthError('Agent is not allowed to use this tool', 403)
      }
      return context
    },
  }
}
