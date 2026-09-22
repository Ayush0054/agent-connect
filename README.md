# Agent Connect

A framework-neutral MCP gateway for website tools. An owner signs in to the admin app with Cloudflare Access, connects a website with OAuth, creates an agent, and grants individual website tools. Agno, Codex, LangGraph, and other MCP hosts then use the same gateway URL with that agent's token.

```text
MCP host ── agent bearer token ──▶ Agent Connect Worker ── website OAuth token ──▶ Website MCP server
                                   │
                                   └── PlanetScale: agents, grants, encrypted tokens, action log
```

## Stack

- Hono + MCP TypeScript SDK on Cloudflare Workers
- PlanetScale Vitess/MySQL through its HTTP driver
- Cloudflare Access for the admin app
- Web Crypto AES-GCM for website token encryption

Agno is an optional MCP host, not a service dependency.

## What is implemented

1. Create an agent; its gateway token is shown once and only its SHA-256 hash is stored.
2. Register a website's MCP URL and public OAuth client configuration.
3. Connect the website with authorization code + PKCE. Website access and refresh tokens are encrypted before storage.
4. Discover website tools and grant them individually to an agent.
5. Serve the granted tools from `/mcp`. A tool call checks the grant again, obtains a website token, calls the website MCP server, and records an outcome.
6. Revoke an agent or disconnect a website from the admin page.

The gateway currently supports websites that provide a public OAuth client ID, authorization endpoint, token endpoint, and remote Streamable HTTP MCP server. The website must allow the configured callback URL and PKCE. OAuth discovery, dynamic client registration, and a website SDK are later work.

## Setup

1. Create a PlanetScale **Vitess/MySQL** database and apply [schema.sql](schema.sql) in its console or your migration process.
2. Set `PUBLIC_BASE_URL` to the admin origin and `MCP_BASE_URL` to the separate MCP origin in `wrangler.jsonc`. Route both domains to this Worker.
3. Protect the **admin origin** with a Cloudflare Access application. Set `ACCESS_ISSUER` to `https://<team>.cloudflareaccess.com` and `ACCESS_AUD` to that application's audience tag. Leave the MCP origin available to clients; the Worker checks its agent bearer token.
4. Add `DATABASE_HOST`, `DATABASE_USERNAME`, `DATABASE_PASSWORD`, and `ENCRYPTION_KEY` as Worker secrets. Generate the key as 32 random bytes encoded with base64url. Keep it stable: changing it makes stored website credentials unreadable.
5. Register `${PUBLIC_BASE_URL}/oauth/callback` as the redirect URI with each website OAuth client. Use that website's OAuth client ID in the admin form. The MCP server must accept the resulting access token.
6. Install dependencies and deploy when ready with `npm install` and `npm run deploy`.

For local development, copy `.dev.vars.example` to `.dev.vars`, fill in values, and run `npm run dev`. Local development also needs a valid Cloudflare Access assertion or a dedicated development authentication setup; the Worker does not bypass authentication.

## Host configuration

Set the MCP server URL to `MCP_BASE_URL/mcp` and use the newly created agent token as a bearer token. The dashboard displays both after agent creation. Tools appear as `<connection-id>__<website-tool-name>` to avoid collisions. The website OAuth token never goes to the host.

## Security and current limits

- Configure Cloudflare Access on the admin origin before exposing it. The Worker verifies the Access JWT's signature, issuer, and audience; admin APIs never return website credentials.
- Website URLs must be HTTPS and cannot be IP literals or local hostnames. This is an initial URL check; stricter destination controls and DNS rebinding defenses are needed before accepting untrusted website registrations.
- Downstream tokens are sent only to the configured website MCP server. Agent tokens are only for this gateway and cannot be used at website servers.
- This version handles tool listing and calls. It does not proxy MCP resources, prompts, subscriptions, or long running tasks.
- Tool lists are read live on each MCP request. This keeps grants current but adds latency and makes unavailable websites temporarily disappear from the list. Cache invalidation and rate limits are future work.
- Disconnect removes local credentials and grants. It does not call the website's OAuth revocation endpoint. Revoke access at the website too if immediate upstream revocation is required.
- The gateway bearer token is still entered once in the host's MCP configuration. Automating that host authorization step requires OAuth support at the gateway and host integration; website OAuth is automated here.

## Status

Implementation is a first slice. Per repository instruction, code execution, builds, and tests have not been run yet.
