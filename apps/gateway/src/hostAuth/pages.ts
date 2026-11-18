// HTML for the consent page an MCP host sends the user to.
import { html } from 'hono/html'
import type { Agent } from '../types/agents'
import type { Connection } from '../types/connections'
import type { AuthorizeParams } from '../types/hostAuth'

type Html = ReturnType<typeof html>

/** A connected app and its tools, or `tools: null` when the app could not be reached. */
export type ConsentApp = { connection: Connection; tools: { name: string; description: string }[] | null }

function page(title: string, body: Html, status = 200) {
  return new Response(String(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Agent Connect</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f5f1; --panel: #fff; --ink: #17201b; --muted: #5f6b63; --line: #dfe3dc; --accent: #1f4d36; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111613; --panel: #19201b; --ink: #e8ece7; --muted: #9aa69d; --line: #2c352f; --accent: #7fc49b; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 34rem; margin: 3rem auto; padding: 0 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { font-size: 1.35rem; margin: 0 0 4px; } .muted { color: var(--muted); } .kicker { font-size: 11px; letter-spacing: .12em; color: var(--muted); }
  fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 16px 0; padding: 12px 14px; } legend { font-weight: 600; padding: 0 4px; }
  label { display: flex; gap: 8px; align-items: baseline; margin: 6px 0; } input[type=text], select { flex: 1; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); }
  .app { font-weight: 600; margin: 10px 0 2px; } .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--panel); }
  code { font-size: 13px; }
</style></head><body><main><div class="kicker">AGENT CONNECT</div>${body}</main></body></html>`), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
  })
}

export const errorPage = (message: string) => page('Cannot connect', html`<div class="card"><h1>Cannot connect this host</h1><p>${message}</p></div>`, 400)

export function consentPage({ client, redirectUri, state, codeChallenge }: AuthorizeParams, agents: Pick<Agent, 'id' | 'name'>[], apps: ConsentApp[]) {
  const redirectHost = new URL(redirectUri).host || new URL(redirectUri).protocol
  return page('Connect a host', html`<div class="card">
      <h1>Connect ${client.client_name}</h1>
      <p class="muted">An MCP host wants to use your connected apps through Agent Connect. It will return to <code>${redirectHost}</code>.
        ${client.metadataDocument ? html`Its identity is published at <code>${new URL(client.client_id).host}</code>.` : html`The host chose this name itself; only continue if you just started this connection.`}</p>
      <form method="post" action="/oauth/authorize">
        ${Object.entries({ client_id: client.client_id, redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: 'S256', response_type: 'code' })
          .map(([key, value]) => html`<input type="hidden" name="${key}" value="${value}">`)}
        <fieldset><legend>Agent</legend>
          <label><input type="radio" name="agent_mode" value="new" checked> New agent named <input type="text" name="agent_name" value="${client.client_name}" maxlength="100" aria-label="New agent name"></label>
          ${agents.length ? html`<label><input type="radio" name="agent_mode" value="existing"> Existing agent <select name="agent_id" aria-label="Existing agent">${agents.map(agent => html`<option value="${agent.id}">${agent.name}</option>`)}</select></label>` : ''}
        </fieldset>
        <fieldset><legend>Tools this agent may use</legend>
          ${apps.length ? apps.map(({ connection, tools }) => html`<div class="app">${connection.name}</div>
            ${tools === null ? html`<p class="muted">Could not reach this app right now.</p>` : tools.length ? tools.map(tool => html`<label><input type="checkbox" name="tool" value="${connection.id}::${tool.name}"> <span><code>${tool.name}</code> <span class="muted">${tool.description}</span></span></label>`) : html`<p class="muted">No tools.</p>`}`)
          : html`<p class="muted">No apps connected yet. You can connect apps and grant tools later in the control plane.</p>`}
        </fieldset>
        <div class="actions"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="allow">Allow</button></div>
      </form>
    </div>`)
}
