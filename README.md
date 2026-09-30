# Agent Connect

Agent Connect lets a user approve an app once, then grant its MCP tools to individual agents. Agno, Codex, LangGraph, and other MCP hosts all connect through the same gateway.

```text
Agent host ── gateway token ──▶ Hono gateway ── app OAuth token + signed agent identity ──▶ App MCP server
                                │                                                        ▲
                                ├── PlanetScale                                           │
                                └── React control plane                           Server SDK verifies
```

## Monorepo

| Path | Purpose |
| --- | --- |
| `apps/gateway` | Hono Cloudflare Worker, OAuth connection flow, PlanetScale storage, MCP router, agent assertions |
| `apps/web` | React + Vite control plane for connections, agents, grants, and activity |
| `packages/server-sdk` | Framework-neutral TypeScript SDK for any app backend to publish discovery and verify agent requests |
| `examples/notes-app` | Local example app with its own OAuth server and MCP server, using the server SDK |

The frontend is served as static assets by the gateway Worker on the admin origin. The MCP origin is separate. Cloudflare Access protects the admin origin; per-agent gateway tokens protect the MCP origin.

## Flow

1. An app backend uses `@agent-connect/server-sdk` to publish `/.well-known/agent-connect.json` and verify tool requests. The app already provides OAuth and a remote MCP server.
2. The user enters the app service URL in the control plane. The gateway fetches discovery details and starts OAuth authorization code + PKCE.
3. The user adds the gateway's MCP URL to any MCP host. The host follows standard MCP OAuth (protected resource metadata, dynamic client registration or a client ID metadata document, PKCE) and opens a consent page where the user names the agent and picks its tools. Hosts without OAuth can still use a static per-agent token.
4. On a call, the gateway checks the grant, uses the app OAuth token, and sends a short ES256 signed assertion naming the agent and tool. The server SDK verifies the assertion and binds it to the app token.

The server SDK works for web apps and native apps with a hosted service. A native app without a reachable HTTPS backend cannot use this remote gateway directly.

## Local development

Requires Node 22+ and Docker.

```bash
npm install
npm run setup:dev      # writes apps/gateway/.dev.vars with fresh local keys
npm run db:up          # MySQL + PlanetScale HTTP simulator on 127.0.0.1:3900
npm run build:web && npm run build:sdk
npm run dev:gateway    # admin on http://localhost:8787, MCP on http://127.0.0.1:8787
npm run dev:notes      # example app on http://localhost:4000
node scripts/e2e.mjs   # connect app, two agents, grants, tool calls, revoke
```

Local mode swaps Cloudflare Access for a fixed `DEV_OWNER` and allows `http://` app URLs on loopback hosts. Both only apply when `.dev.vars` sets them and `PUBLIC_BASE_URL` is a loopback `http://` origin.

## Setup

1. `npm install` at the monorepo root.
2. Create a PlanetScale **Vitess/MySQL** database and apply `apps/gateway/schema.sql`.
3. Set `PUBLIC_BASE_URL` (admin origin), `MCP_BASE_URL` (MCP origin), `ACCESS_ISSUER`, and `ACCESS_AUD` in `apps/gateway/wrangler.jsonc`. Route both origins to the gateway Worker.
4. Protect the admin origin with Cloudflare Access. Leave the MCP origin available to clients; the Worker validates agent bearer tokens there.
5. Configure Worker secrets: `DATABASE_HOST`, `DATABASE_USERNAME`, `DATABASE_PASSWORD`, `ENCRYPTION_KEY`, and `ASSERTION_PRIVATE_JWK`. `apps/gateway/.dev.vars.example` lists their expected shape. Keep the encryption key and assertion private key stable.
6. Generate a P-256 key pair for assertions and store the **private JWK** as `ASSERTION_PRIVATE_JWK`. Its public key is served at `MCP_BASE_URL/.well-known/agent-connect/jwks.json`. Configure apps to trust that exact MCP origin.
7. Register `PUBLIC_BASE_URL/oauth/callback` as a redirect URI for each app OAuth client. The app must accept `resource` set to its MCP URL.
8. Run `npm run build:sdk` to prepare the server SDK for local consumers. Run `npm run deploy` when the Cloudflare domains and secrets are ready; deployment builds the frontend and deploys the Worker.

For an app without discovery, the control plane retains a manual OAuth and MCP setup form.

## Current limits

- The server SDK does not implement an OAuth authorization server or an MCP server. It wraps an app's existing ones.
- App-side `authorizeAgent` policy is optional. If omitted, the app trusts gateway grants plus its own OAuth consent. Native app teams can add their own agent approval UI and policy callback.
- The custom discovery document and signed agent assertion are an Agent Connect integration contract, not an MCP standard. Standard MCP OAuth and protected resource metadata remain the app's responsibility.
- The gateway currently proxies MCP tools only. Resources, prompts, subscriptions, and long running tasks are outside this first slice.
- Tokens are encrypted at rest. Disconnect deletes local tokens and grants, but does not call the app's token revocation endpoint.
- Public URL validation is basic; stronger destination controls are needed before accepting untrusted app registrations.
