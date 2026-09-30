import { useCallback, useEffect, useRef, useState } from 'react'
import { api, send, type Agent, type Connection, type Overview, type Tool } from './api'
import { ActivityPage, AgentsPage, ConnectionsPage, OverviewPage, PermissionsPage } from './pages'

type View = 'overview' | 'connections' | 'agents' | 'permissions' | 'activity'
type IssuedToken = { name: string; token: string; mcp_url: string }

const navigation: { id: View; label: string; number: string }[] = [
  { id: 'overview', label: 'Overview', number: '01' },
  { id: 'connections', label: 'Connections', number: '02' },
  { id: 'agents', label: 'Agents', number: '03' },
  { id: 'permissions', label: 'Permissions', number: '04' },
  { id: 'activity', label: 'Activity', number: '05' },
]

export function App() {
  const [view, setView] = useState<View>('overview')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [issued, setIssued] = useState<IssuedToken | null>(null)
  const [selectedAgent, setSelectedAgent] = useState('')
  const [selectedConnection, setSelectedConnection] = useState('')
  const [tools, setTools] = useState<Tool[]>([])
  const [toolsLoading, setToolsLoading] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const result = await api<Overview>('/api/overview')
      setOverview(result)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the dashboard')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const connected = new URLSearchParams(window.location.search).get('connected')
    if (connected) {
      setNotice('App connected. You can now grant its tools to agents.')
      window.history.replaceState({}, '', '/')
    }
  }, [])
  useEffect(() => {
    if (!overview) return
    setSelectedAgent(current => overview.agents.some(agent => agent.id === current && !agent.revoked_at)
      ? current : overview.agents.find(agent => !agent.revoked_at)?.id ?? '')
    setSelectedConnection(current => overview.connections.some(connection => connection.id === current && connection.connected_at)
      ? current : overview.connections.find(connection => connection.connected_at)?.id ?? '')
  }, [overview])
  useEffect(() => {
    if (!selectedConnection) { setTools([]); return }
    let active = true
    setToolsLoading(true)
    api<{ tools: Tool[] }>(`/api/connections/${encodeURIComponent(selectedConnection)}/tools`)
      .then(result => { if (active) { setTools(result.tools); setError('') } })
      .catch(cause => { if (active) { setTools([]); setError(cause instanceof Error ? cause.message : 'Could not load tools') } })
      .finally(() => { if (active) setToolsLoading(false) })
    return () => { active = false }
  }, [selectedConnection])

  async function mutate(task: () => Promise<void>) {
    setPending(true)
    setError('')
    setNotice('')
    try { await task(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed') }
    finally { setPending(false) }
  }

  function createAgent(name: string) {
    return mutate(async () => {
      const result = await send<Agent & { token: string; mcp_url: string }>('/api/agents', { name })
      setIssued({ name: result.name, token: result.token, mcp_url: result.mcp_url })
      setNotice(`${result.name} was created.`)
    })
  }

  function connectApp(values: Record<string, unknown>) {
    return mutate(async () => {
      const result = await send<{ authorize_url: string }>('/api/connections', values)
      window.location.assign(result.authorize_url)
    })
  }

  function revokeAgent(agent: Agent) {
    if (!window.confirm(`Revoke ${agent.name} and its gateway token?`)) return
    void mutate(async () => {
      await send(`/api/agents/${encodeURIComponent(agent.id)}/revoke`, {})
      setNotice(`${agent.name} was revoked.`)
    })
  }

  function disconnect(connection: Connection) {
    if (!window.confirm(`Disconnect ${connection.name} and remove its agent grants?`)) return
    void mutate(async () => {
      await send(`/api/connections/${encodeURIComponent(connection.id)}/disconnect`, {})
      setNotice(`${connection.name} was disconnected.`)
    })
  }

  function toggleGrant(toolName: string, granted: boolean) {
    if (!selectedAgent || !selectedConnection) return
    void mutate(async () => {
      await send('/api/grants', {
        agent_id: selectedAgent, connection_id: selectedConnection, tool_name: toolName,
      }, granted ? 'DELETE' : 'POST')
      setNotice(granted ? 'Tool access removed.' : 'Tool access granted.')
    })
  }

  const title = navigation.find(item => item.id === view)?.label ?? 'Overview'

  return <div className="shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand"><span className="brand-mark" aria-hidden="true">AC</span><span><strong>Agent Connect</strong><small>Control plane</small></span></div>
      <div className="sidebar-label">WORKSPACE</div>
      <nav className="nav-list" aria-label="Sections">
        {navigation.map(item => <button key={item.id} type="button" onClick={() => setView(item.id)}
          className={view === item.id ? 'nav-item active' : 'nav-item'} aria-current={view === item.id ? 'page' : undefined}>
          <span className="nav-number">{item.number}</span>{item.label}
        </button>)}
      </nav>
      <div className="sidebar-bottom"><span className="live-dot" />Gateway workspace <span className="version">v0.1</span></div>
    </aside>

    <main id="main-content" className="main-content">
      <header className="topbar"><div><span className="eyebrow">AGENT CONNECT / {title.toUpperCase()}</span><h1>{title}</h1></div><span className="environment"><span className="live-dot" />Private workspace</span></header>
      {error && <div className="alert error" role="alert"><span>{error}</span><button type="button" onClick={() => { setError(''); void refresh() }}>Retry</button></div>}
      {notice && <div className="alert success" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}
      {loading && <div className="loading-state" role="status">Loading your workspace…</div>}
      {!loading && overview && <>
        {view === 'overview' && <OverviewPage data={overview} navigate={setView} />}
        {view === 'connections' && <ConnectionsPage connections={overview.connections} pending={pending} onConnect={connectApp} onDisconnect={disconnect} />}
        {view === 'agents' && <AgentsPage agents={overview.agents} mcpUrl={overview.mcp_url} pending={pending} onCreate={createAgent} onRevoke={revokeAgent} />}
        {view === 'permissions' && <PermissionsPage data={overview} tools={tools} toolsLoading={toolsLoading} pending={pending}
          agentId={selectedAgent} connectionId={selectedConnection} onAgentChange={setSelectedAgent}
          onConnectionChange={setSelectedConnection} onToggle={toggleGrant} navigate={setView} />}
        {view === 'activity' && <ActivityPage data={overview} />}
      </>}
    </main>
    <TokenDialog issued={issued} onClose={() => setIssued(null)} />
  </div>
}

function TokenDialog({ issued, onClose }: { issued: IssuedToken | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (issued && !dialog.current?.open) dialog.current?.showModal()
    if (!issued && dialog.current?.open) dialog.current.close()
    setCopied(false)
  }, [issued])
  return <dialog ref={dialog} className="token-dialog" onClose={onClose} aria-labelledby="token-title">
    {issued && <div className="dialog-inner">
      <div className="dialog-kicker">NEW AGENT CREDENTIAL</div>
      <h2 id="token-title">Connect {issued.name}</h2>
      <p>For hosts without OAuth support. Copy these values into the host; the token is shown only once.</p>
      <div className="credential"><span>MCP SERVER URL</span><code>{issued.mcp_url}</code></div>
      <div className="credential"><span>BEARER TOKEN</span><code>{issued.token}</code></div>
      <div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>Done</button>
        <button type="button" className="button primary" onClick={async () => {
          try { await navigator.clipboard.writeText(issued.token); setCopied(true) } catch { setCopied(false) }
        }}>{copied ? 'Copied token' : 'Copy token'}</button></div>
    </div>}
  </dialog>
}
