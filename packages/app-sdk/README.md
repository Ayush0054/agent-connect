# App SDK

Install this package in an application backend that already has an OAuth authorization server and a remote MCP server. A web app, SaaS service, or native app with a hosted backend can use the same package. It does two jobs:

1. Publish `/.well-known/agent-connect.json` so Agent Connect can fill in the app's MCP and OAuth settings from its URL.
2. Verify the app OAuth token plus Agent Connect's signed, short-lived agent assertion for each MCP tool call.

```ts
import { createAppSdk, AgentConnectAuthError } from '@agent-connect/app-sdk'

const connect = createAppSdk({
  name: 'Notes',
  mcpUrl: 'https://notes.example.com/mcp',
  oauth: {
    authorizationUrl: 'https://notes.example.com/oauth/authorize',
    tokenUrl: 'https://notes.example.com/oauth/token',
    clientId: 'your-public-client-id',
    scope: 'notes:read notes:write',
  },
  gatewayIssuer: 'https://mcp.connect.example.com',
  verifyAccessToken: async token => {
    // Validate this site's token, audience, expiry, and scopes using your auth system.
    const user = await yourAuth.validateAccessToken(token)
    return user ? { userId: user.id } : null
  },
  authorizeAgent: async ({ appUserId, agentId, toolName }) => {
    // Optional: enforce app-side agent permissions from your database.
    return yourDatabase.agentCanUseTool(appUserId, agentId, toolName)
  },
})

// Route on the app's public service origin:
app.get('/.well-known/agent-connect.json', () => connect.discoveryResponse())

// Inside your MCP tool handler, pass its raw HTTP request and registered tool name:
const identity = await connect.verifyToolCall(request, 'notes.create')
// identity.appUserId and identity.agentId can be recorded with the action.
```

`verifyToolCall` throws `AgentConnectAuthError` with a 401 or 403 status. Convert it to your MCP server's error response. It does not implement OAuth or an MCP server, and it does not replace validation of the app's own access token. The `authorizeAgent` callback is optional; without it the app relies on the gateway's per-agent grants and the app OAuth consent.

The assertion verifies the gateway signature using a fixed trusted JWKS URL, checks issuer and MCP audience, binds the assertion to the app token with `ath`, and checks the requested tool name. The app sees an agent ID only after both credentials verify. A future version can add app-managed agent registration and a consent screen that names the agent.

Native apps use this package in their hosted backend or API. A local-only desktop or mobile app needs a reachable HTTPS MCP/OAuth service for other agents to connect through this gateway.
