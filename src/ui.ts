export const dashboard = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Connect</title>
  <style>
    :root { color-scheme: light; font: 15px/1.5 system-ui, sans-serif; background: #f5f6f4; color: #172019 }
    * { box-sizing: border-box }
    body { max-width: 1080px; margin: 0 auto; padding: 32px 20px 72px }
    h1 { font-size: 32px; letter-spacing: -.04em; margin: 0 }
    h2 { font-size: 19px; margin: 0 0 16px }
    p { color: #5b665e; margin: 5px 0 20px }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 18px }
    section { background: white; border: 1px solid #dce2dc; border-radius: 14px; padding: 22px; margin-top: 18px }
    form { display: grid; gap: 10px }
    label { display: grid; gap: 4px; font-weight: 600; font-size: 13px }
    input, select { width: 100%; padding: 10px 12px; border: 1px solid #cbd4cc; border-radius: 8px; background: white; font: inherit }
    button, .button { border: 0; border-radius: 8px; background: #175c38; color: white; font: inherit; padding: 9px 13px; cursor: pointer; text-decoration: none; display: inline-block }
    button.secondary, .button.secondary { background: #e9eee9; color: #203829 }
    button.danger { background: #a33535 }
    button:disabled { opacity: .55; cursor: default }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-top: 1px solid #edf0ed }
    .row:first-child { border-top: 0 }
    .row strong { display: block }
    small { color: #657067 }
    .actions { display: flex; gap: 7px; flex-wrap: wrap }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #eef4ee; border: 1px solid #c9ddce; padding: 13px; border-radius: 8px }
    #message { min-height: 22px; color: #8a2d26 }
    .tool { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: center; padding: 10px 0; border-top: 1px solid #edf0ed }
    code { font-size: 12px; overflow-wrap: anywhere }
  </style>
</head>
<body>
  <header><h1>Agent Connect</h1><p>Connect a website once, then grant its MCP tools to individual agents.</p></header>
  <div id="message" role="status" aria-live="polite"></div>
  <div class="grid">
    <section><h2>Agents</h2>
      <form id="agent-form"><label>Agent name<input name="name" required maxlength="100" placeholder="Research assistant"></label><button>Create agent</button></form>
      <div id="new-token" hidden></div><div id="agents"></div>
    </section>
    <section><h2>Website connections</h2>
      <form id="connection-form">
        <label>Website name<input name="name" required placeholder="Example App"></label>
        <label>MCP server URL<input name="mcp_url" type="url" required placeholder="https://example.com/mcp"></label>
        <label>OAuth authorization URL<input name="authorization_url" type="url" required></label>
        <label>OAuth token URL<input name="token_url" type="url" required></label>
        <label>OAuth client ID<input name="client_id" required></label>
        <label>Scopes<input name="scope" placeholder="read write"></label>
        <button>Add website</button>
      </form><div id="connections"></div>
    </section>
  </div>
  <section><h2>Tool permissions</h2><p>Select an agent and a connected website, then grant only the tools it needs.</p>
    <div class="grid"><label>Agent<select id="grant-agent"></select></label><label>Website<select id="grant-connection"></select></label></div>
    <div id="tools"></div>
  </section>
  <section><h2>Recent actions</h2><div id="actions"></div></section>
  <script>
    let state = { agents: [], connections: [], grants: [], actions: [] };
    const byId = id => document.getElementById(id);
    const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
    const note = message => { byId('message').textContent = message; };
    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    }
    async function load() {
      state = await api('/api/overview');
      render();
    }
    function option(value, label) { const item = el('option', label); item.value = value; return item; }
    function action(label, onClick, style) {
      const button = el('button', label); button.type = 'button'; if (style) button.className = style;
      button.addEventListener('click', async () => { try { note(''); await onClick(); } catch (error) { note(error.message); } });
      return button;
    }
    function render() {
      const agents = byId('agents'); agents.replaceChildren();
      for (const agent of state.agents) {
        const row = el('div'); row.className = 'row';
        const label = el('div'); label.append(el('strong', agent.name), el('small', agent.revoked_at ? 'Revoked' : agent.id)); row.append(label);
        if (!agent.revoked_at) row.append(action('Revoke', async () => {
          if (!confirm('Revoke this agent and its gateway token?')) return;
          await api('/api/agents/' + encodeURIComponent(agent.id) + '/revoke', { method: 'POST', body: '{}' }); await load();
        }, 'danger'));
        agents.append(row);
      }
      const connections = byId('connections'); connections.replaceChildren();
      for (const connection of state.connections) {
        const row = el('div'); row.className = 'row';
        const label = el('div'); label.append(el('strong', connection.name), el('small', connection.connected_at ? 'Connected' : 'Not connected')); row.append(label);
        const controls = el('div'); controls.className = 'actions';
        const link = el('a', connection.connected_at ? 'Reconnect' : 'Connect'); link.className = 'button secondary'; link.href = '/api/connections/' + encodeURIComponent(connection.id) + '/authorize'; controls.append(link);
        if (connection.connected_at) controls.append(action('Disconnect', async () => {
          if (!confirm('Disconnect this website and remove its agent grants?')) return;
          await api('/api/connections/' + encodeURIComponent(connection.id) + '/disconnect', { method: 'POST', body: '{}' }); await load();
        }, 'danger'));
        row.append(controls); connections.append(row);
      }
      const agentSelect = byId('grant-agent'), connectionSelect = byId('grant-connection');
      const selectedAgent = agentSelect.value, selectedConnection = connectionSelect.value;
      agentSelect.replaceChildren(option('', 'Choose agent'));
      connectionSelect.replaceChildren(option('', 'Choose website'));
      state.agents.filter(a => !a.revoked_at).forEach(a => agentSelect.append(option(a.id, a.name)));
      state.connections.filter(c => c.connected_at).forEach(c => connectionSelect.append(option(c.id, c.name)));
      agentSelect.value = selectedAgent; connectionSelect.value = selectedConnection;
      const actions = byId('actions'); actions.replaceChildren();
      for (const item of state.actions) {
        const row = el('div'); row.className = 'row'; row.append(el('code', item.tool_name), el('small', item.outcome + ' · ' + item.created_at)); actions.append(row);
      }
      if (!state.actions.length) actions.append(el('small', 'No actions yet.'));
      showTools();
    }
    async function showTools() {
      const target = byId('tools'); target.replaceChildren();
      const agentId = byId('grant-agent').value, connectionId = byId('grant-connection').value;
      if (!agentId || !connectionId) return;
      target.append(el('small', 'Loading website tools…'));
      try {
        const data = await api('/api/connections/' + encodeURIComponent(connectionId) + '/tools');
        if (connectionId !== byId('grant-connection').value) return;
        target.replaceChildren();
        for (const tool of data.tools) {
          const granted = state.grants.some(g => g.agent_id === agentId && g.connection_id === connectionId && g.tool_name === tool.name);
          const row = el('div'); row.className = 'tool';
          const label = el('div'); label.append(el('strong', tool.name), el('small', tool.description || 'No description')); row.append(label);
          row.append(action(granted ? 'Remove grant' : 'Grant tool', async () => {
            await api('/api/grants', { method: granted ? 'DELETE' : 'POST', body: JSON.stringify({ agent_id: agentId, connection_id: connectionId, tool_name: tool.name }) });
            await load();
          }, granted ? 'secondary' : ''));
          target.append(row);
        }
        if (!data.tools.length) target.append(el('small', 'No tools returned by this website.'));
      } catch (error) { target.replaceChildren(el('small', error.message)); }
    }
    byId('grant-agent').addEventListener('change', showTools);
    byId('grant-connection').addEventListener('change', showTools);
    byId('agent-form').addEventListener('submit', async event => {
      event.preventDefault(); note('');
      try {
        const data = await api('/api/agents', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
        const box = byId('new-token'); box.hidden = false; box.replaceChildren(el('strong', 'Copy this token now. It is shown only once.'), el('pre', 'MCP URL: ' + data.mcp_url + '\nBearer token: ' + data.token));
        event.target.reset(); await load();
      } catch (error) { note(error.message); }
    });
    byId('connection-form').addEventListener('submit', async event => {
      event.preventDefault(); note('');
      try {
        const data = await api('/api/connections', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
        location.assign(data.authorize_url);
      } catch (error) { note(error.message); }
    });
    load().catch(error => note(error.message));
  </script>
</body>
</html>`
