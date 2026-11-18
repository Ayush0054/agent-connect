# Agent Connect — log

Decisions we took and what we implemented, newest first. What we want to build is in [SPEC.md](SPEC.md).

Each entry has: **Decision** (what we chose and why), **Implemented** (what changed in the code), **Verified** (what was actually run), and **Open** (what is known to be missing or weak).

---

## 2026-11-19 — Restructure `apps/gateway/src` into folders

Branch `feat/openapi-adapter`, [Ayush0054/agent-connect#1](https://github.com/Ayush0054/agent-connect/pull/1).

**Decision**

1. Use the same layout as the Agno Gateway Worker (`types/`, `routes/`, `middleware/`, `stores/`, `upstream/`, `mcp/`, `utils/`, `constants.ts`, `app.ts`, `index.ts`). Reason: eight flat files mixed types, SQL, HTTP handlers and calls to apps; `core.ts` alone held the database helpers, encryption, URL checks, auth and all types.
2. Keep it to plain functions. No classes, no adapter interface, no repository objects. Reason: there are only two kinds of connection (`mcp`, `openapi`); an `if (connection.kind === 'openapi')` in two places is easier to read than an abstraction.
3. All SQL lives in `stores/`. Each function is one query with a name that says what it does (`getConnection`, `hasGrant`, `deleteGrantsForMissingTools`). Reason: routes read as steps, and every query on a table can be found in one file.
4. `types/api.ts` is the contract for `/api/*`. The gateway checks its responses against it with `satisfies`, and `apps/web` imports the same types. Reason: the web app had its own copy of these shapes, which could drift without any error.
5. Behaviour must not change. This entry moves code; it does not add features or fix the weaknesses listed under 2026-11-17.

**Implemented**

- Removed `core.ts`, `assertion.ts`, `discovery.ts`, `hostAuth.ts`, `mcp.ts`, `oauth.ts`, `openapi.ts`. Their code is now in:

  | Old file | New location |
  | --- | --- |
  | `core.ts` | `types/env.ts`, `types/agents.ts`, `types/connections.ts`, `stores/db.ts`, `utils/crypto.ts`, `utils/urls.ts`, `middleware/adminAuth.ts` |
  | `index.ts` | `index.ts` (entry only), `app.ts`, `routes/health.ts`, `routes/mcp.ts`, `routes/api/*` |
  | `hostAuth.ts` | `hostAuth/authorize.ts`, `hostAuth/pages.ts`, `routes/oauth.ts`, `routes/wellKnown.ts`, `stores/hostAuth.ts`, `types/hostAuth.ts` |
  | `oauth.ts` | `upstream/appOAuth.ts`, `stores/oauthStates.ts` |
  | `mcp.ts` | `mcp/server.ts`, `mcp/tools.ts`, `upstream/mcpApp.ts` |
  | `openapi.ts` | `upstream/openapiSpec.ts` (import), `upstream/restApp.ts` (calls), `stores/connectionTools.ts`, `types/tools.ts` |
  | `assertion.ts`, `discovery.ts` | `upstream/assertion.ts`, `upstream/discovery.ts`, `utils/http.ts` |

- Limits and lifetimes that were scattered as literals are named in `constants.ts`.
- `apps/web/src/api.ts` imports its types from `apps/gateway/src/types/api.ts`.
- Three queries changed shape but not result: the refresh route and the consent form now load the connection with `getConnection` and check `kind` / `access_token_ciphertext` in code instead of in the `WHERE` clause.
- README: text architecture diagram and a code layout section. Added `docs/SPEC.md` and this file.

**Verified**

- `tsc --noEmit` passes for `apps/gateway` and `apps/web`; `vite build` of the web app passes.
- `node scripts/e2e-openapi.mjs`: 30 of 30 checks pass.
- `node scripts/e2e.mjs`: 31 of 31 checks pass (app OAuth, grants, tool calls, host OAuth, refresh, revoke).
- These ran against Homebrew Postgres 14 and a 20-line stand-in for the Neon HTTP proxy, because Docker Desktop would not stay running on the development machine. The `docker compose` stack (Postgres 17 + the real proxy) was **not** re-run after the restructure.

**Open**

- Nothing new. The weaknesses listed under 2026-11-17 are unchanged.
- The package folder is still named `apps/gateway`, as it has been since 2026-09-23. It was not renamed.

---

## 2026-11-17 — OpenAPI adapter: connect a REST app without an MCP server

Commits `a5ef51e`, `7d0fb1c`.

**Decision**

1. Agent Connect builds the MCP tools itself from an OpenAPI spec and calls the REST API directly. Reason: a legacy app then needs no MCP server, no OAuth server and no SDK.
2. Import the spec once at connect time and store the tools in `connection_tools`. Reason: listing tools must not fetch and parse a spec on every MCP request.
3. A connection has a `kind` (`mcp` or `openapi`) and an `auth_kind` (`oauth` or `api_key`). An API key is stored in the existing `access_token_ciphertext` column, encrypted the same way as OAuth tokens.
4. Reuse `connections.mcp_url` for the REST base URL. Reason: avoids renaming a column used by the gateway, the web app and the assertion audience. Cost: the name is misleading for REST connections.
5. REST calls also carry the `Agent-Connect-Assertion` header. Reason: an app can start verifying the agent later without being reconnected.
6. Grants, the consent page, the activity log and host OAuth are reused unchanged for REST apps.
7. An API-key connection is deleted on disconnect; an OAuth connection is kept. Reason: there is no sign-in page to reconnect an API key through.
8. Skip operations that only accept non-JSON bodies, instead of importing tools that cannot work.

**Implemented**

- Schema: five new columns on `connections`, new table `connection_tools`, migration `apps/gateway/migrations/001_openapi.sql` for existing databases.
- Spec import: JSON and YAML, `$ref` inlining, one tool per operation, limits of 2 MB, 300 operations and 30 seconds.
- REST call: path, query and JSON body from tool arguments; same-origin check; no redirects; 30-second timeout; 100 KB response cap; HTTP 400+ becomes a tool error.
- API: `POST /api/connections` with `kind: "openapi"`, `POST /api/connections/:id/refresh`.
- Control plane: import form on the Connections page, `REST` / `MCP` labels.
- `examples/legacy-api`: a Tasks REST API with an `X-API-Key` header and an OpenAPI spec.
- `scripts/e2e-openapi.mjs`: 30 checks.
- Fixes found by importing the public Petstore spec: header names may contain `_` (`api_key`); upload operations are skipped; no doubled full stop in descriptions; spec fetch timeout raised from 15 to 30 seconds.

**Verified**

- Both end-to-end scripts passed on the `docker compose` stack.
- Live calls to the public Petstore API through `/mcp`: `get_inventory`, `find_pets_by_status`, a 404 returned as a tool error, and an invalid argument refused by the schema.

**Open**

1. Saving imported tools is not atomic: it deletes all rows and inserts them one request at a time. A failure in the middle leaves a connection with part of its tools.
2. `mcp_url` holds two different things (decision 4).
3. `connections` mixes OAuth fields, API-key fields and spec fields in one row.
4. `input_schema` and `params` are stored as `TEXT`, not `JSONB`.
5. No foreign keys between tables.
6. `parseSpec` has no unit tests.
7. Not tested: OAuth for a REST app, a third-party API that needs a real key, a deployed Worker.
8. A grant is tied to a tool name. If a re-import keeps the name but changes the method or path, the grant still applies to the changed operation.

---

## 2026-10-01 — Host OAuth, Neon, local end-to-end run

Commits `c033297`, `e08b3e7`, `ec3f385`, `c0366ba`.

**Decision**

1. MCP hosts sign in with OAuth (metadata, client registration, PKCE, consent page) instead of a pasted token. Static agent tokens remain for hosts without OAuth.
2. Move the database from PlanetScale to Neon Postgres, using Neon's HTTP driver so it runs in a Worker.
3. Local development uses Postgres plus a Neon HTTP proxy in Docker, so the same driver runs unchanged.

**Implemented**

- Host OAuth server and consent page; tables `oauth_clients`, `host_auth_codes`, `agent_tokens`.
- `scripts/e2e.mjs`, `scripts/dev-setup.mjs`, `scripts/seed-demo.mjs`, `docker-compose.yml`.
- README with screenshots.

**Verified**

- `scripts/e2e.mjs` passed locally. Not verified against each real host (Claude Code, Codex, Cursor).

---

## 2026-09-23 — First version

Commits `63afa0c`, `d49f1b7`, `1d8fcff`.

**Decision**

1. One Hono app on Cloudflare Workers serves the control plane, the API and `/mcp`.
2. Apps publish `/.well-known/agent-connect.json` and verify agents with `@agent-connect/server-sdk`.
3. Permissions are per agent and per tool, and each agent can be revoked on its own.

**Implemented**

- Monorepo: `apps/gateway`, `apps/web`, `packages/server-sdk`, `examples/notes-app`.
- App OAuth with PKCE, encrypted tokens, grants, activity log, signed agent assertion.
