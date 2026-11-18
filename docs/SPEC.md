# Agent Connect — spec

What we are building. Each requirement is marked **Built** (in the code and covered by an end-to-end check), **Built, untested** (in the code, no check yet), or **Not built**.

Decisions and progress are recorded in [LOG.md](LOG.md).

## 1. Goal

A person connects an app once. After that, any AI agent can use that app through MCP, limited to the tools the person approved for that agent.

The app can be:

- **An app with an MCP server.** It also has OAuth and uses `@agent-connect/server-sdk`.
- **A legacy app with only a REST API.** It has an OpenAPI 3 spec and an API key or OAuth. Nothing changes in the app.

## 2. Who uses it

| Who | What they do |
| --- | --- |
| Owner | Connects apps, creates agents, grants tools, reads the activity log. Uses the control plane (`apps/web`). |
| MCP host | Claude Code, Codex, Cursor or an SDK client. Talks MCP to `/mcp` on behalf of one agent. |
| App | Receives the calls. Gets its own credential plus a signed statement of which agent is acting. |

## 3. Requirements

### 3.1 Connect an app

| # | Requirement | Status |
| --- | --- | --- |
| C1 | Connect an MCP app from its URL by reading `/.well-known/agent-connect.json`, then signing in on the app's OAuth page (PKCE S256). | Built |
| C2 | Connect an MCP app by entering its endpoints by hand. | Built, untested |
| C3 | Connect a REST app from an OpenAPI 3.x spec URL (JSON or YAML) and an API key. Connected at once, no browser step. | Built |
| C4 | Connect a REST app from an OpenAPI spec and the app's OAuth endpoints. | Built, untested |
| C5 | The API key is sent in a header the owner chooses (default `Authorization: Bearer <key>`). | Built |
| C6 | App credentials are stored encrypted (AES-GCM) and are never returned by the API. | Built |
| C7 | Re-import a spec after the API changes. Grants for operations that still exist are kept; grants for removed operations are deleted. | Built |
| C8 | Disconnect an app. Its grants are deleted. An API-key connection is deleted with its key; an OAuth connection is kept so the owner can sign in again. | Built |

### 3.2 Turn an OpenAPI spec into tools

| # | Requirement | Status |
| --- | --- | --- |
| S1 | One tool per operation (`get`, `post`, `put`, `patch`, `delete`). The name is the `operationId` in snake_case, or `<method>_<path>`. | Built |
| S2 | Path and query parameters are top-level tool arguments. A JSON request body is the `body` argument. | Built |
| S3 | `$ref`s inside the document are inlined. `nullable` becomes a JSON Schema type array. | Built |
| S4 | The base URL is the spec's first server, or a URL the owner enters. | Built |
| S5 | Operations that only take non-JSON bodies (uploads, forms) are skipped. Header and cookie parameters are ignored. | Built |
| S6 | Limits: spec up to 2 MB and 300 operations, fetched within 30 seconds; a tool schema over 32 KB keeps only its argument names. | Built |
| S7 | Tell the owner which operations were skipped and why. | Not built |
| S8 | Parameter styles other than the default (`style`, `explode`), and `$ref`s to other documents. | Not built |

### 3.3 Agents and permissions

| # | Requirement | Status |
| --- | --- | --- |
| P1 | An agent has a name and can be revoked on its own. Revoking it stops its tokens at once. | Built |
| P2 | A grant is one agent + one connection + one tool. An agent sees and can call only granted tools. | Built |
| P3 | The grant is checked again on every tool call. | Built |
| P4 | A tool that the app does not have cannot be granted. | Built |
| P5 | Every tool call is written to the activity log with its outcome: `success`, `tool_error` or `transport_error`. | Built |

### 3.4 MCP hosts

| # | Requirement | Status |
| --- | --- | --- |
| H1 | A host connects with only the MCP URL: OAuth metadata, dynamic client registration or a client ID metadata document, PKCE. | Built |
| H2 | The owner approves the host on a consent page, picks or creates the agent, and ticks its tools. | Built |
| H3 | Access tokens last 1 hour. Refresh tokens last 30 days and work once. | Built |
| H4 | A host without OAuth can use a static agent token from the control plane. | Built |
| H5 | Tool names seen by the host are `<connection id>__<tool>`. | Built |

### 3.5 Calling the app

| # | Requirement | Status |
| --- | --- | --- |
| A1 | MCP app: forward the call with the app's OAuth token. | Built |
| A2 | REST app: build one HTTP request from the tool arguments and send it with the stored credential. | Built |
| A3 | Every call carries `Agent-Connect-Assertion`: an ES256 JWT, valid 60 seconds, naming the agent and the tool, bound to the app token by its hash. | Built |
| A4 | An HTTP status of 400 or above from a REST app is returned as a tool error with the response text. | Built |
| A5 | REST responses over 100 KB are refused. Redirects are not followed. Calls time out after 30 seconds. | Built |
| A6 | OAuth tokens of apps are refreshed automatically before they expire. | Built |

### 3.6 Safety rules that always hold

| # | Rule | Status |
| --- | --- | --- |
| R1 | Agent Connect only calls public HTTPS URLs. Loopback `http://` is allowed only when `ALLOW_LOOPBACK_APPS=true` (local development). | Built |
| R2 | A REST call cannot leave the connection's base URL origin. Path arguments are percent-encoded; `.` and `..` are refused. | Built |
| R3 | The control plane is on its own origin behind Cloudflare Access. Writes need a same-origin request with a JSON body. | Built |
| R4 | Tokens, codes and OAuth states are stored as SHA-256 hashes. | Built |
| R5 | Every query is limited to the signed-in owner's rows. | Built |

## 4. Data

Postgres on Neon. The schema is `apps/gateway/schema.sql`.

| Table | One row is | Key |
| --- | --- | --- |
| `agents` | An agent of an owner | `id` |
| `connections` | A connected app: kind (`mcp` or `openapi`), URLs, how to sign in, encrypted credential | `id` |
| `connection_tools` | A tool imported from an OpenAPI spec: method, path, input schema, where each argument goes | `connection_id, tool_name` |
| `grants` | Permission for an agent to call a tool of a connection | `agent_id, connection_id, tool_name` |
| `action_log` | One tool call and its outcome | `id` |
| `oauth_states` | A pending sign-in to an app | `state_hash` |
| `oauth_clients` | A registered MCP host | `client_id` |
| `host_auth_codes` | A one-time code for a host, valid 60 seconds | `code_hash` |
| `agent_tokens` | An access or refresh token of an agent | `token_hash` |

`connections.mcp_url` holds the MCP endpoint for `mcp` connections and the REST base URL for `openapi` connections.

## 5. Interfaces

| Interface | Used by | Defined in |
| --- | --- | --- |
| `/api/*` (JSON) | `apps/web` | `apps/gateway/src/types/api.ts` — the web app imports the same types |
| `/mcp` (MCP over HTTP) | MCP hosts | `apps/gateway/src/mcp/server.ts` |
| `/oauth/*` and `/.well-known/oauth-*` | MCP hosts | `apps/gateway/src/routes/oauth.ts`, `routes/wellKnown.ts` |
| `/.well-known/agent-connect.json` | Published by MCP apps | `AppManifest` in `apps/gateway/src/types/connections.ts` |
| `Agent-Connect-Assertion` header and `/.well-known/agent-connect/jwks.json` | Apps | `apps/gateway/src/upstream/assertion.ts` |

## 6. Not built

These are known gaps, not plans with dates.

1. Apps with neither an MCP server nor an OpenAPI spec (UI-only platforms).
2. Verifying the agent assertion in a plain REST handler with the server SDK. Today the SDK verifies it only inside MCP tool handlers.
3. MCP resources, prompts, subscriptions and long-running tasks. Only tools are proxied.
4. Non-JSON request bodies, file downloads and pagination helpers for REST apps.
5. Checkpointing, replay or undo of agent actions.
6. Rate limiting of client registration.
7. Calling an app's token revocation endpoint on disconnect.
8. Unit tests. The code is covered by two end-to-end scripts only, and there is no CI.
