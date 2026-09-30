import { useState, type FormEvent, type ReactNode } from 'react'
import type { Agent, Connection, Overview, Tool } from './api'

type View = 'overview' | 'connections' | 'agents' | 'permissions' | 'activity'

function when(value: string | null): string {
  if (!value) return 'Never'
  const parsed = new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z'))
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function SectionHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="section-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>
}

function Empty({ title, description }: { title: string; description: string }) {
  return <div className="empty"><span className="empty-symbol" aria-hidden="true">◎</span><h3>{title}</h3><p>{description}</p></div>
}

export function OverviewPage({ data, navigate }: { data: Overview; navigate: (view: View) => void }) {
  const connected = data.connections.filter(connection => connection.connected_at)
  const activeAgents = data.agents.filter(agent => !agent.revoked_at)
  return <div className="page-stack">
    <div className="intro"><div><span className="eyebrow">YOUR ACCESS NETWORK</span><h2>Give agents access with intention.</h2><p>Connect an app once, then choose exactly which tools each agent can use.</p></div><button className="button primary" onClick={() => navigate('connections')}>Connect app <span aria-hidden="true">↗</span></button></div>
    <div className="metrics">
      <div><span>CONNECTED APPS</span><strong>{connected.length.toString().padStart(2, '0')}</strong><small>OAuth connections</small></div>
      <div><span>ACTIVE AGENTS</span><strong>{activeAgents.length.toString().padStart(2, '0')}</strong><small>Gateway credentials</small></div>
      <div><span>TOOL GRANTS</span><strong>{data.grants.length.toString().padStart(2, '0')}</strong><small>Explicit permissions</small></div>
    </div>
    <div className="content-grid">
      <section className="panel"><SectionHeading title="Connections" description="Apps available to your agents" action={<button className="text-button" onClick={() => navigate('connections')}>View all →</button>} />
        {!data.connections.length ? <Empty title="No apps connected" description="Start with an app that exposes Agent Connect discovery." /> :
          <div className="item-list">{data.connections.slice(0, 4).map(connection => <div className="list-row" key={connection.id}><span className="site-avatar">{connection.name.slice(0, 1).toUpperCase()}</span><div className="row-main"><strong>{connection.name}</strong><small>{new URL(connection.mcp_url).hostname}</small></div><span className={connection.connected_at ? 'status connected' : 'status idle'}>{connection.connected_at ? 'Connected' : 'Needs login'}</span></div>)}</div>}
      </section>
      <section className="panel"><SectionHeading title="Agents" description="Clients with gateway access" action={<button className="text-button" onClick={() => navigate('agents')}>View all →</button>} />
        {!data.agents.length ? <Empty title="No agents yet" description="Create an agent to receive a gateway MCP credential." /> :
          <div className="item-list">{data.agents.slice(0, 4).map(agent => <div className="list-row" key={agent.id}><span className="agent-avatar" aria-hidden="true">◇</span><div className="row-main"><strong>{agent.name}</strong><small>Created {when(agent.created_at)}</small></div><span className={agent.revoked_at ? 'status idle' : 'status connected'}>{agent.revoked_at ? 'Revoked' : 'Active'}</span></div>)}</div>}
      </section>
    </div>
    <section className="panel"><SectionHeading title="Recent activity" description="The latest app tool calls" action={<button className="text-button" onClick={() => navigate('activity')}>View history →</button>} />
      <ActivityList data={data} limit={4} />
    </section>
  </div>
}

export function ConnectionsPage({ connections, pending, onConnect, onDisconnect }: {
  connections: Connection[]; pending: boolean; onConnect: (values: Record<string, unknown>) => Promise<void>; onDisconnect: (connection: Connection) => void
}) {
  async function submitApp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const app_url = String(new FormData(form).get('app_url') ?? '').trim()
    if (app_url) await onConnect({ app_url })
  }
  async function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await onConnect(Object.fromEntries(new FormData(event.currentTarget)))
  }
  return <div className="page-stack">
    <section className="panel connect-panel"><div><span className="eyebrow">NEW CONNECTION</span><h2>Connect an app</h2><p>Paste its service URL. Agent Connect will discover its MCP server and start the app’s approval flow.</p></div>
      <form className="url-form" onSubmit={submitApp}><label className="sr-only" htmlFor="app-url">App service URL</label><input id="app-url" type="url" name="app_url" placeholder="https://app.example.com" required disabled={pending} /><button className="button primary" disabled={pending}>{pending ? 'Connecting…' : 'Continue'}</button></form>
      <details className="manual-setup"><summary>Manual setup for apps without discovery</summary><form className="form-grid" onSubmit={submitManual}>
        <label>App name<input name="name" required maxLength={100} placeholder="My app" /></label>
        <label>MCP server URL<input name="mcp_url" type="url" required placeholder="https://example.com/mcp" /></label>
        <label>OAuth authorization URL<input name="authorization_url" type="url" required /></label>
        <label>OAuth token URL<input name="token_url" type="url" required /></label>
        <label>Public OAuth client ID<input name="client_id" required /></label>
        <label>Scopes<input name="scope" placeholder="read write" /></label>
        <button className="button secondary" disabled={pending}>Connect manually</button>
      </form></details>
    </section>
    <section className="panel"><SectionHeading title="Your apps" description={`${connections.length} registered ${connections.length === 1 ? 'app' : 'apps'}`} />
      {!connections.length ? <Empty title="No apps yet" description="Enter an app service URL above to add your first connection." /> :
        <div className="item-list">{connections.map(connection => <div className="list-row connection-row" key={connection.id}>
          <span className="site-avatar">{connection.name.slice(0, 1).toUpperCase()}</span><div className="row-main"><strong>{connection.name}</strong><small>{connection.mcp_url}</small></div>
          <span className={connection.connected_at ? 'status connected' : 'status idle'}>{connection.connected_at ? 'Connected' : 'Needs login'}</span>
          <div className="row-actions"><a className="button small secondary" href={`/api/connections/${encodeURIComponent(connection.id)}/authorize`}>{connection.connected_at ? 'Reconnect' : 'Connect'}</a>
            {connection.connected_at && <button className="button small quiet-danger" disabled={pending} onClick={() => onDisconnect(connection)}>Disconnect</button>}</div>
        </div>)}</div>}
    </section>
  </div>
}

export function AgentsPage({ agents, mcpUrl, pending, onCreate, onRevoke }: {
  agents: Agent[]; mcpUrl: string; pending: boolean; onCreate: (name: string) => Promise<void>; onRevoke: (agent: Agent) => void
}) {
  const [copied, setCopied] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const name = String(new FormData(form).get('name') ?? '').trim()
    if (name) { await onCreate(name); form.reset() }
  }
  return <div className="page-stack">
    <section className="panel connect-panel"><div><span className="eyebrow">CONNECT A HOST</span><h2>Add Agent Connect to your MCP host</h2><p>Add this URL as a remote MCP server in Claude Code, Codex, Cursor, or any host that supports MCP OAuth. The host opens a browser page where you name the agent and choose its tools. No token to copy.</p></div>
      <div className="url-form"><code className="mcp-url">{mcpUrl}</code><button type="button" className="button primary" onClick={async () => {
        try { await navigator.clipboard.writeText(mcpUrl); setCopied(true) } catch { setCopied(false) }
      }}>{copied ? 'Copied' : 'Copy URL'}</button></div>
    </section>
    <section className="panel connect-panel"><div><span className="eyebrow">MANUAL TOKEN</span><h2>Create an agent with a token</h2><p>For hosts without OAuth support. The agent gets a static gateway token; grant app tools after creating it.</p></div>
      <form className="url-form" onSubmit={submit}><label className="sr-only" htmlFor="agent-name">Agent name</label><input id="agent-name" name="name" maxLength={100} required placeholder="Research assistant" disabled={pending} /><button className="button primary" disabled={pending}>{pending ? 'Creating…' : 'Create agent'}</button></form>
    </section>
    <section className="panel"><SectionHeading title="Your agents" description={`${agents.filter(agent => !agent.revoked_at).length} active`} />
      {!agents.length ? <Empty title="No agents yet" description="Create an agent above to receive its MCP gateway details." /> :
        <div className="item-list">{agents.map(agent => <div className="list-row connection-row" key={agent.id}><span className="agent-avatar" aria-hidden="true">◇</span><div className="row-main"><strong>{agent.name}</strong><small>Created {when(agent.created_at)} · {agent.id}</small></div><span className={agent.revoked_at ? 'status idle' : 'status connected'}>{agent.revoked_at ? 'Revoked' : 'Active'}</span>
          {!agent.revoked_at && <button className="button small quiet-danger" disabled={pending} onClick={() => onRevoke(agent)}>Revoke</button>}</div>)}</div>}
    </section>
  </div>
}

export function PermissionsPage({ data, tools, toolsLoading, pending, agentId, connectionId, onAgentChange, onConnectionChange, onToggle, navigate }: {
  data: Overview; tools: Tool[]; toolsLoading: boolean; pending: boolean; agentId: string; connectionId: string;
  onAgentChange: (value: string) => void; onConnectionChange: (value: string) => void;
  onToggle: (tool: string, granted: boolean) => void; navigate: (view: View) => void
}) {
  const agents = data.agents.filter(agent => !agent.revoked_at)
  const connections = data.connections.filter(connection => connection.connected_at)
  return <div className="page-stack">
    <section className="panel"><SectionHeading title="Choose an agent and app" description="Tool permissions are granted separately for each pair." />
      <div className="selector-grid"><label>AGENT<select value={agentId} onChange={event => onAgentChange(event.target.value)}><option value="">Select agent</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        <label>APP<select value={connectionId} onChange={event => onConnectionChange(event.target.value)}><option value="">Select app</option>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label></div>
    </section>
    <section className="panel"><SectionHeading title="Available tools" description="The app’s live MCP tool catalog" />
      {!agents.length && <Empty title="Create an agent first" description="Each agent needs its own credential and tool grants." />}
      {!!agents.length && !connections.length && <div className="empty"><h3>Connect an app first</h3><p>An app’s tools appear here after you approve its OAuth connection.</p><button className="button secondary" onClick={() => navigate('connections')}>Go to connections</button></div>}
      {!!agents.length && !!connections.length && (!agentId || !connectionId) && <Empty title="Select both sides" description="Choose an agent and an app to manage their tool access." />}
      {!!agentId && !!connectionId && toolsLoading && <div className="loading-state" role="status">Loading app tools…</div>}
      {!!agentId && !!connectionId && !toolsLoading && !tools.length && <Empty title="No tools available" description="This app returned no MCP tools, or its server could not be reached." />}
      {!!agentId && !!connectionId && !toolsLoading && !!tools.length && <div className="item-list">{tools.map(tool => {
        const granted = data.grants.some(grant => grant.agent_id === agentId && grant.connection_id === connectionId && grant.tool_name === tool.name)
        return <div className="tool-row" key={tool.name}><div><strong>{tool.name}</strong><p>{tool.description || 'No description provided by the app.'}</p></div>
          <button className={granted ? 'button small secondary' : 'button small primary'} disabled={pending} onClick={() => onToggle(tool.name, granted)}>{granted ? 'Remove access' : 'Grant access'}</button></div>
      })}</div>}
    </section>
  </div>
}

function ActivityList({ data, limit }: { data: Overview; limit?: number }) {
  const actions = limit ? data.actions.slice(0, limit) : data.actions
  if (!actions.length) return <Empty title="No actions yet" description="App tool calls will appear here once your agents start using them." />
  return <div className="item-list">{actions.map(action => {
    const agent = data.agents.find(item => item.id === action.agent_id)
    const connection = data.connections.find(item => item.id === action.connection_id)
    return <div className="activity-row" key={action.id}><span className={action.outcome === 'success' ? 'activity-indicator good' : 'activity-indicator bad'} aria-hidden="true" />
      <div className="row-main"><strong>{action.tool_name}</strong><small>{agent?.name ?? 'Unknown agent'} → {connection?.name ?? 'Unknown app'}</small></div>
      <span className="outcome">{action.outcome.replace('_', ' ')}</span><time>{when(action.created_at)}</time></div>
  })}</div>
}

export function ActivityPage({ data }: { data: Overview }) {
  return <section className="panel"><SectionHeading title="Connection and action history" description="Recent tool outcomes; arguments and results are not stored." /><ActivityList data={data} /></section>
}
