// Console SPA (§8): one page, hash-routed, every F-* surface wired to its REST endpoint.
// Static string — no server-side interpolation; all API data is escaped client-side.
export const INDEX_HTML: string = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Platform Console</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#e2e2e2; --card:#fafafa; --accent:#0b62d6;
          --red:#b3261e; --redbg:#fdeceb; --yellow:#7a5d00; --yellowbg:#fff8dc; --green:#0a6b3d; --greenbg:#e7f6ee; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#101214; --fg:#e6e6e6; --muted:#9aa0a6; --line:#2c3136; --card:#16191c; --accent:#6aa9ff;
            --red:#f2b8b5; --redbg:#3a1d1b; --yellow:#ffd97a; --yellowbg:#3a3212; --green:#7bd8a8; --greenbg:#123626; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 -apple-system, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  a { color: var(--accent); text-decoration: none; }
  #layout { display:flex; min-height:100vh; }
  #nav { width:210px; border-right:1px solid var(--line); padding:12px 0; flex-shrink:0; }
  #nav h1 { font-size:15px; margin:4px 16px 2px; }
  #nav .sub { font-size:11px; color:var(--muted); margin:0 16px 10px; }
  #nav a { display:block; padding:5px 16px; color:var(--fg); border-left:3px solid transparent; }
  #nav a.on { border-left-color:var(--accent); background:var(--card); font-weight:600; }
  #nav .grp { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:12px 16px 2px; }
  #main { flex:1; padding:18px 26px; max-width:1080px; min-width:0; }
  #projbar { display:flex; gap:8px; align-items:center; margin-bottom:14px; flex-wrap:wrap; }
  #projbar label { color:var(--muted); font-size:12px; }
  select, input[type=text], input[type=number], input[type=password], textarea {
    font:13px/1.4 ui-monospace, Menlo, monospace; color:var(--fg); background:var(--bg);
    border:1px solid var(--line); border-radius:6px; padding:5px 8px; max-width:100%; }
  textarea { width:100%; min-height:140px; }
  button { font:13px -apple-system, system-ui, sans-serif; padding:5px 12px; border-radius:6px;
    border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:var(--red); border-color:var(--red); }
  .card { border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin:0 0 12px; background:var(--card); }
  .card h2 { font-size:14px; margin:0 0 8px; }
  .muted { color:var(--muted); font-size:12px; }
  .warn-red { background:var(--redbg); color:var(--red); border-color:var(--red); }
  .warn-yellow { background:var(--yellowbg); color:var(--yellow); border-color:var(--yellow); }
  .ok { background:var(--greenbg); color:var(--green); border-color:var(--green); }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  td, th { text-align:left; padding:4px 10px 4px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; }
  pre { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:10px;
        overflow-x:auto; font-size:12px; max-height:420px; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:6px 0; }
  .pill { display:inline-block; font-size:11px; border:1px solid var(--line); border-radius:99px; padding:1px 8px; }
  #toast { position:fixed; bottom:16px; right:16px; max-width:420px; z-index:9; }
  #toast .t { border-radius:8px; padding:10px 14px; margin-top:8px; border:1px solid var(--line);
              background:var(--card); box-shadow:0 4px 14px #0003; font-size:13px; }
  .actions button { margin-right:4px; margin-bottom:2px; font-size:12px; padding:2px 8px; }
</style>
</head>
<body>
<div id="layout">
  <nav id="nav">
    <h1>Platform Console</h1>
    <p class="sub" id="disclaimer"></p>
    <div class="grp">Operate</div>
    <a href="#/status">Status</a>
    <a href="#/projects">Projects</a>
    <a href="#/sessions">Sessions</a>
    <a href="#/terminal">Terminal</a>
    <a href="#/usage">Usage &amp; Quota</a>
    <a href="#/activity">Activity Feed</a>
    <div class="grp">Autonomous</div>
    <a href="#/loop">Loop Console</a>
    <a href="#/sched">Scheduler</a>
    <div class="grp">Govern</div>
    <a href="#/settings">Settings</a>
    <a href="#/permissions">Permissions</a>
    <a href="#/auth">Auth &amp; Env</a>
    <a href="#/memory">Memory</a>
    <div class="grp">Extend</div>
    <a href="#/mcp">MCP</a>
    <a href="#/hooks">Hooks</a>
    <a href="#/subagents">Subagents</a>
    <a href="#/skills">Skills &amp; Plugins</a>
    <div class="grp">Maintain</div>
    <a href="#/system">System &amp; Retention</a>
  </nav>
  <main id="main"></main>
</div>
<div id="toast"></div>
<script>
'use strict';
const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const toast = (msg, cls) => {
  const d = document.createElement('div');
  d.className = 't ' + (cls || '');
  d.textContent = msg;
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), 6000);
};
// Apply-timing is communicated on every save (§8)
const savedToast = (applyNote) => toast('Saved. ' + (applyNote || 'Applies to new sessions; running sessions keep their config.'), 'ok');

async function api(url, opts) {
  const r = await fetch(url, opts && opts.body != null
    ? { ...opts, headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body) }
    : opts);
  if (r.status === 401) { renderLogin(); throw new Error('unauthorized'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || (url + ' -> HTTP ' + r.status));
  return data;
}
const fail = (e) => toast(String(e.message || e), 'warn-red');

// ---- project context: ?project=<path> is deep-linkable on every page (§8) ----
const getProject = () => new URLSearchParams(location.search).get('project') || '';
const setProject = (p) => {
  const q = new URLSearchParams(location.search);
  if (p) q.set('project', p); else q.delete('project');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
  route();
};
const dirQ = () => { const p = getProject(); return p ? '?dir=' + encodeURIComponent(p) : ''; };
const dirAmp = () => { const p = getProject(); return p ? '&dir=' + encodeURIComponent(p) : ''; };

function renderLogin() {
  $('#main').innerHTML =
    '<div class="card" style="max-width:380px"><h2>Sign in</h2>' +
    '<p class="muted">Remote auth is enabled (fail-closed, single operator).</p>' +
    '<div class="row"><input type="password" id="pw" placeholder="operator password">' +
    '<button class="primary" id="loginBtn">Login</button></div></div>';
  $('#loginBtn').onclick = async () => {
    try { await api('/api/auth/login', { method: 'POST', body: { password: $('#pw').value } }); location.reload(); }
    catch (e) { fail(e); }
  };
}

async function projectBar() {
  let opts = '<option value="">(all projects / server cwd)</option>';
  try {
    const { projects } = await api('/api/projects');
    opts += projects.map((p) =>
      '<option value="' + esc(p.path) + '"' + (p.path === getProject() ? ' selected' : '') + '>' +
      esc(p.path) + (p.loopManaged ? ' [loop-managed]' : '') + '</option>').join('');
  } catch { /* login flow handles 401 */ }
  return '<div id="projbar"><label>Project</label><select id="projsel">' + opts + '</select></div>';
}

const pages = {};

// ---- F-Status ----
pages.status = async (root) => {
  const st = await api('/api/status');
  const term = await api('/api/term').catch(() => ({ terminals: [] }));
  const usage = await api('/api/usage');
  $('#disclaimer').textContent = st.disclaimer;
  root.innerHTML =
    '<div class="card"><h2>Status</h2>' +
    '<table><tr><th>CLI</th><td>' + esc(st.cli) + '</td></tr>' +
    '<tr><th>Auth</th><td>' + esc(st.auth.method) + '</td></tr>' +
    '<tr><th>Active terminals</th><td>' + term.terminals.length + '</td></tr></table></div>' +
    st.auth.warnings.map((w) => '<div class="card warn-' + esc(w.severity) + '"><b>' + esc(w.variable) + '</b> — ' + esc(w.message) + '</div>').join('') +
    '<div class="card"><h2>Quota (estimate)</h2>' +
    'window 5h: <b>' + usage.currentWindow.sessions + '</b> sessions · week: <b>' + usage.week.sessions + '</b> sessions' +
    '<div class="muted">' + esc(usage.label) + ' · ' + esc(usage.officialSource) + '</div></div>' +
    '<div class="card"><h2>Active runs</h2>' +
    (term.terminals.length
      ? '<table>' + term.terminals.map((t) => '<tr><td>' + esc(t.id) + '</td><td class="muted">' + esc(t.cwd) + '</td>' +
        '<td><a target="_blank" href="/terminal?attach=' + esc(t.id) + '">attach</a></td></tr>').join('') + '</table>'
      : '<span class="muted">no interactive terminals — autonomous runs appear in Loop Console</span>') +
    '</div>';
};

// ---- F-Proj ----
pages.projects = async (root) => {
  const { projects } = await api('/api/projects');
  root.innerHTML =
    '<div class="card"><h2>Register directory</h2><div class="row">' +
    '<input type="text" id="regdir" placeholder="/absolute/path" size="50">' +
    '<button class="primary" id="regbtn">Register</button></div>' +
    '<div class="muted">Creates the project entry the CLI uses under ~/.claude/projects.</div></div>' +
    '<div class="card"><h2>Projects (' + projects.length + ')</h2><table>' +
    projects.map((p) =>
      '<tr><td><a href="#/sessions" data-proj="' + esc(p.path) + '">' + esc(p.path) + '</a></td>' +
      '<td>' + (p.loopManaged ? '<span class="pill warn-yellow">loop-managed (.ai/goal.yaml)</span>' : '') + '</td></tr>').join('') +
    '</table></div>';
  $('#regbtn').onclick = async () => {
    try { const r = await api('/api/projects/register', { method: 'POST', body: { dir: $('#regdir').value } });
      toast('Registered as ' + r.key, 'ok'); route(); } catch (e) { fail(e); }
  };
  root.onclick = (ev) => {
    const a = ev.target.closest('a[data-proj]');
    if (a) setProject(a.dataset.proj);
  };
};

// ---- F-Sess ----
pages.sessions = async (root) => {
  const { sessions } = await api('/api/sessions?limit=50' + dirAmp());
  const rowsHtml = (list) => list.map((s) =>
    '<tr data-id="' + esc(s.sessionId) + '" data-cwd="' + esc(s.cwd || '') + '">' +
    '<td>' + esc((s.customTitle || s.summary || s.firstPrompt || s.sessionId).slice(0, 70)) + '</td>' +
    '<td>' + (s.tag ? '<span class="pill">' + esc(s.tag) + '</span>' : '') + '</td>' +
    '<td class="muted">' + new Date(s.lastModified).toLocaleString() + '</td>' +
    '<td class="actions">' +
    '<button data-act="resume">resume</button><button data-act="rename">rename</button>' +
    '<button data-act="tag">tag</button><button data-act="fork">fork</button>' +
    '<button data-act="export">export</button><button data-act="del" class="danger">delete</button>' +
    '</td></tr>').join('');
  root.innerHTML =
    '<div class="card"><h2>Search transcripts (FTS)</h2><div class="row">' +
    '<input type="text" id="q" placeholder="search text" size="34"><button id="qbtn" class="primary">Search</button>' +
    '<button id="reindex">Rebuild index</button><span class="muted" id="idxstate"></span></div>' +
    '<div id="hits"></div></div>' +
    '<div class="card"><h2>Sessions</h2>' +
    '<div class="row"><input type="text" id="filter" placeholder="filter (e.g. loop:)" size="24"></div>' +
    '<table id="sesstab"><tr><th>Title</th><th>Tag</th><th>Last modified</th><th></th></tr>' + rowsHtml(sessions) + '</table></div>';

  $('#filter').oninput = () => {
    const f = $('#filter').value.toLowerCase();
    const filtered = sessions.filter((s) =>
      !f || (s.tag || '').toLowerCase().startsWith(f) ||
      JSON.stringify([s.summary, s.customTitle, s.firstPrompt]).toLowerCase().includes(f));
    $('#sesstab').innerHTML = '<tr><th>Title</th><th>Tag</th><th>Last modified</th><th></th></tr>' + rowsHtml(filtered);
  };
  $('#qbtn').onclick = async () => {
    try {
      const { hits } = await api('/api/sessions/search?q=' + encodeURIComponent($('#q').value));
      $('#hits').innerHTML = hits.length
        ? '<table>' + hits.map((h) => '<tr><td>' + esc(h.snippet) + '</td><td class="muted">' + esc(h.sessionId.slice(0, 8)) + '</td></tr>').join('') + '</table>'
        : '<div class="muted">no hits — rebuild the index if transcripts are new</div>';
    } catch (e) { fail(e); }
  };
  $('#reindex').onclick = async () => {
    try {
      const { actionId } = await api('/api/sessions/search/index', { method: 'POST' });
      $('#idxstate').textContent = 'indexing…';
      const poll = setInterval(async () => {
        const a = await api('/api/actions/' + actionId + '/status');
        if (a.status !== 'running') {
          clearInterval(poll);
          $('#idxstate').textContent = a.status === 'done'
            ? 'indexed ' + a.result.indexed + ' / total ' + a.result.total : 'error: ' + a.error;
        }
      }, 700);
    } catch (e) { fail(e); }
  };
  $('#sesstab').onclick = async (ev) => {
    const btn = ev.target.closest('button'); if (!btn) return;
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id, cwd = tr.dataset.cwd;
    const acts = {
      resume: () => window.open('/terminal?project=' + encodeURIComponent(cwd || getProject() || '') + '&resume=' + id, '_blank'),
      rename: async () => { const t = prompt('New title'); if (t) { await api('/api/sessions/' + id + '/rename', { method: 'POST', body: { title: t } }); route(); } },
      tag: async () => { const t = prompt('Tag (empty clears)'); await api('/api/sessions/' + id + '/tag', { method: 'POST', body: { tag: t || null } }); route(); },
      fork: async () => { const r = await api('/api/sessions/' + id + '/fork', { method: 'POST', body: {} }); toast('Forked -> ' + r.sessionId, 'ok'); route(); },
      export: () => { location.href = '/api/sessions/' + id + '/export'; },
      del: async () => { if (confirm('Delete session ' + id + '? The transcript file is removed.')) { await api('/api/sessions/' + id, { method: 'DELETE' }); route(); } },
    };
    try { await acts[btn.dataset.act](); } catch (e) { fail(e); }
  };
};

// ---- F-Term ----
pages.terminal = async (root) => {
  const { terminals } = await api('/api/term');
  root.innerHTML =
    '<div class="card"><h2>New terminal (real claude CLI via PTY — 100% parity)</h2>' +
    '<div class="row"><button class="primary" id="spawn">Spawn claude</button>' +
    '<span class="muted">cwd = ' + esc(getProject() || '(server cwd)') + ' · opens in a new tab · closing the tab detaches, the session keeps running</span></div></div>' +
    '<div class="card"><h2>Running terminals</h2>' +
    (terminals.length ? '<table>' + terminals.map((t) =>
      '<tr><td>' + esc(t.id) + '</td><td class="muted">' + esc(t.cwd) + '</td>' +
      '<td><a target="_blank" href="/terminal?attach=' + esc(t.id) + '">attach</a></td>' +
      '<td><button class="danger" data-id="' + esc(t.id) + '">kill</button></td></tr>').join('') + '</table>'
      : '<span class="muted">none</span>') + '</div>';
  $('#spawn').onclick = () => window.open('/terminal?project=' + encodeURIComponent(getProject() || ''), '_blank');
  root.onclick = async (ev) => {
    const b = ev.target.closest('button.danger'); if (!b) return;
    if (confirm('Kill terminal ' + b.dataset.id + '?')) {
      try { await fetch('/api/term/' + b.dataset.id, { method: 'DELETE' }); route(); } catch (e) { fail(e); }
    }
  };
};

// ---- F-Set ----
pages.settings = async (root) => {
  root.innerHTML =
    '<div class="card"><h2>Settings editor</h2>' +
    '<div class="row"><label>Scope</label><select id="scope"><option>user</option><option>project</option><option>local</option></select>' +
    '<button id="load">Load</button><button class="primary" id="save">Save</button><span class="muted" id="hash"></span></div>' +
    '<textarea id="body" spellcheck="false"></textarea>' +
    '<div class="muted" id="applynote">Writes are schema-validated, hash-guarded (409 on concurrent edit) and atomic.</div></div>' +
    '<div class="card"><h2>Effective view (resolved + provenance)</h2><button id="eff">Refresh</button><pre id="effout"></pre></div>';
  let expectedHash;
  const load = async () => {
    try {
      const r = await api('/api/settings/' + $('#scope').value + dirQ());
      $('#body').value = JSON.stringify(r.settings ?? {}, null, 2);
      expectedHash = r.hash;
      $('#hash').textContent = 'hash ' + r.hash;
      $('#applynote').textContent = 'Apply timing: ' + r.applyTiming;
    } catch (e) { fail(e); }
  };
  $('#load').onclick = load;
  $('#scope').onchange = load;
  $('#save').onclick = async () => {
    try {
      const settings = JSON.parse($('#body').value);
      const r = await api('/api/settings/' + $('#scope').value + dirQ(), { method: 'PUT', body: { settings, expectedHash } });
      expectedHash = r.hash; $('#hash').textContent = 'hash ' + r.hash;
      savedToast('Apply timing: ' + r.applyTiming + '.');
    } catch (e) { fail(e); }
  };
  $('#eff').onclick = async () => {
    try { $('#effout').textContent = JSON.stringify(await api('/api/settings/effective/view' + dirQ()), null, 2); }
    catch (e) { fail(e); }
  };
  await load();
};

// ---- F-Perm ----
pages.permissions = async (root) => {
  root.innerHTML =
    '<div class="card"><h2>Permission rules</h2>' +
    '<div class="row"><label>Scope</label><select id="scope"><option>user</option><option>project</option><option>local</option></select>' +
    '<button id="load">Load</button><button class="primary" id="save">Save</button></div>' +
    '<div class="row"><div style="flex:1"><b>allow</b><textarea id="allow" placeholder="one rule per line"></textarea></div>' +
    '<div style="flex:1"><b>deny</b><textarea id="deny"></textarea></div>' +
    '<div style="flex:1"><b>ask</b><textarea id="ask"></textarea></div></div>' +
    '<div class="row"><button id="protect">Install deny rules protecting test/golden/** + worktrees/</button></div>' +
    '<div class="muted">Applies to new sessions.</div></div>' +
    '<div class="card"><h2>Merged view + simulator</h2>' +
    '<div class="row"><input type="text" id="simtool" placeholder="tool e.g. Bash" size="14">' +
    '<input type="text" id="simarg" placeholder="arg e.g. rm -rf" size="24"><button id="sim" class="primary">Simulate</button></div>' +
    '<pre id="merged"></pre></div>';
  let expectedHash;
  const lines = (id) => $('#' + id).value.split('\\n').map((x) => x.trim()).filter(Boolean);
  const load = async () => {
    try {
      const r = await api('/api/permissions/' + $('#scope').value + dirQ());
      $('#allow').value = (r.allow ?? []).join('\\n');
      $('#deny').value = (r.deny ?? []).join('\\n');
      $('#ask').value = (r.ask ?? []).join('\\n');
      expectedHash = r.hash;
    } catch (e) { fail(e); }
  };
  $('#load').onclick = load;
  $('#scope').onchange = load;
  $('#save').onclick = async () => {
    try {
      await api('/api/permissions/' + $('#scope').value + dirQ(),
        { method: 'PUT', body: { allow: lines('allow'), deny: lines('deny'), ask: lines('ask'), expectedHash } });
      savedToast(); await load();
    } catch (e) { fail(e); }
  };
  $('#protect').onclick = async () => {
    try { await api('/api/permissions/protect-golden' + dirQ(), { method: 'POST' }); savedToast('Golden/worktree deny rules installed (project scope).'); await load(); }
    catch (e) { fail(e); }
  };
  $('#sim').onclick = async () => {
    try {
      const q = '/api/permissions/merged/view' + (dirQ() ? dirQ() + '&' : '?') +
        'tool=' + encodeURIComponent($('#simtool').value) + '&arg=' + encodeURIComponent($('#simarg').value);
      $('#merged').textContent = JSON.stringify(await api(q), null, 2);
    } catch (e) { fail(e); }
  };
  await load();
};

// ---- F-Auth ----
pages.auth = async (root) => {
  const a = await api('/api/auth');
  root.innerHTML =
    '<div class="card"><h2>Active auth</h2><b>' + esc(a.method) + '</b>' +
    '<div class="muted">Auth flows through the Claude Code credential chain only — the console never stores or displays tokens (INV-12).</div></div>' +
    (a.warnings.length
      ? a.warnings.map((w) => '<div class="card warn-' + esc(w.severity) + '"><b>' + esc(w.variable) + '</b> — ' + esc(w.message) + '</div>').join('')
      : '<div class="card ok">No env variables shadow the subscription login.</div>') +
    '<div class="card"><h2>Setup token guidance</h2><div class="muted">Run <code>claude setup-token</code> in a terminal for long-lived headless auth. This console intentionally has no field to paste tokens into.</div></div>';
};

// ---- F-Mem ----
pages.memory = async (root) => {
  root.innerHTML =
    '<div class="card"><h2>CLAUDE.md editor</h2>' +
    '<div class="row"><label>Scope</label><select id="scope"><option>user</option><option>project</option></select>' +
    '<button id="load">Load</button><button class="primary" id="save">Save</button></div>' +
    '<textarea id="body" style="min-height:260px" spellcheck="false"></textarea>' +
    '<div class="muted">Memory is guidance for the model, not enforcement — hard rules belong in Permissions. Applies to new sessions.</div></div>' +
    '<div class="card"><h2>Preview</h2><pre id="prev"></pre></div>';
  let expectedHash;
  const load = async () => {
    try {
      const r = await api('/api/memory/' + $('#scope').value + dirQ());
      $('#body').value = r.content ?? ''; expectedHash = r.hash;
      $('#prev').textContent = r.content ?? '';
    } catch (e) { fail(e); }
  };
  $('#load').onclick = load;
  $('#scope').onchange = load;
  $('#body').oninput = () => { $('#prev').textContent = $('#body').value; };
  $('#save').onclick = async () => {
    try {
      await api('/api/memory/' + $('#scope').value + dirQ(), { method: 'PUT', body: { content: $('#body').value, expectedHash } });
      savedToast(); await load();
    } catch (e) { fail(e); }
  };
  await load();
};

// ---- F-MCP ----
pages.mcp = async (root) => {
  const r = await api('/api/mcp' + dirQ());
  root.innerHTML =
    '<div class="card"><h2>MCP servers (.mcp.json — project scope)</h2><pre>' + esc(JSON.stringify(r.mcpServers ?? {}, null, 2)) + '</pre></div>' +
    '<div class="card"><h2>Add server</h2>' +
    '<div class="row"><input type="text" id="name" placeholder="name" size="16"></div>' +
    '<textarea id="def" placeholder="{&quot;command&quot;:&quot;npx&quot;,&quot;args&quot;:[&quot;-y&quot;,&quot;some-mcp&quot;]} or {&quot;url&quot;:&quot;https://...&quot;}"></textarea>' +
    '<div class="row"><button class="primary" id="add">Add</button>' +
    '<span class="muted">Takes effect on next session start.</span></div></div>';
  $('#add').onclick = async () => {
    try {
      await api('/api/mcp' + dirQ(), { method: 'PUT', body: { name: $('#name').value, server: JSON.parse($('#def').value) } });
      savedToast('New sessions will see this server.'); route();
    } catch (e) { fail(e); }
  };
};

// ---- F-Hook ----
pages.hooks = async (root) => {
  const r = await api('/api/hooks' + dirQ());
  root.innerHTML =
    '<div class="card"><h2>Hooks (merged view)</h2><pre>' + esc(JSON.stringify(r.scopes, null, 2)) + '</pre>' +
    '<div class="muted">The TUI /hooks menu is read-only — this page is the editor.</div></div>' +
    '<div class="card"><h2>Add hook</h2>' +
    '<div class="row"><label>Scope</label><select id="scope"><option>project</option><option>user</option><option>local</option></select>' +
    '<label>Event</label><select id="event">' + r.events.map((e) => '<option>' + esc(e) + '</option>').join('') + '</select></div>' +
    '<div class="row"><input type="text" id="matcher" placeholder="matcher (optional, e.g. Bash)" size="22">' +
    '<input type="text" id="cmd" placeholder="command" size="40"></div>' +
    '<div class="row"><label><input type="checkbox" id="consent"> I understand this command will run on my machine on every matching event</label></div>' +
    '<div class="row"><button class="primary" id="add">Add hook</button><span class="muted">Applies to new sessions.</span></div></div>';
  $('#add').onclick = async () => {
    try {
      const body = { event: $('#event').value, command: $('#cmd').value, consent: $('#consent').checked };
      if ($('#matcher').value) body.matcher = $('#matcher').value;
      await api('/api/hooks/' + $('#scope').value + dirQ(), { method: 'PUT', body });
      savedToast(); route();
    } catch (e) { fail(e); }
  };
};

// ---- F-Sub ----
pages.subagents = async (root) => {
  const r = await api('/api/subagents' + dirQ());
  root.innerHTML =
    '<div class="card"><h2>Subagents (' + esc(r.dir) + ')</h2>' +
    (r.subagents.length ? r.subagents.map((s) => '<h3 class="muted">' + esc(s.file) + '</h3><pre>' + esc(s.content) + '</pre>').join('')
      : '<span class="muted">none</span>') + '</div>' +
    '<div class="card"><h2>Create subagent</h2>' +
    '<div class="row"><input type="text" id="name" placeholder="kebab-case-name" size="22">' +
    '<input type="text" id="desc" placeholder="description" size="40"></div>' +
    '<textarea id="prompt" placeholder="system prompt"></textarea>' +
    '<div class="row"><button class="primary" id="add">Create</button></div></div>';
  $('#add').onclick = async () => {
    try {
      await api('/api/subagents' + dirQ(), { method: 'PUT', body: { name: $('#name').value, description: $('#desc').value, prompt: $('#prompt').value } });
      savedToast('Available to new sessions.'); route();
    } catch (e) { fail(e); }
  };
};

// ---- F-Skill ----
pages.skills = async (root) => {
  const r = await api('/api/skills' + dirQ());
  const list = (xs) => xs.length ? '<ul>' + xs.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '<span class="muted">none</span>';
  root.innerHTML =
    '<div class="card"><h2>User skills (~/.claude/skills)</h2>' + list(r.user) + '</div>' +
    '<div class="card"><h2>Project skills (.claude/skills)</h2>' + list(r.project) + '</div>' +
    '<div class="card"><h2>Plugins</h2><div class="muted">Manage via <code>enabledPlugins</code> in Settings (scope picker there); the marketplace lives in the CLI.</div></div>';
};

// ---- F-Usage ----
pages.usage = async (root) => {
  const u = await api('/api/usage');
  const alerts = await api('/api/usage/alerts');
  const full = await api('/api/usage/full').catch(() => null);
  const tab = (rows, k, v) => rows.length
    ? '<table>' + rows.map((r) => '<tr><td>' + esc(r[k]) + '</td><td>' + r[v] + '</td></tr>').join('') + '</table>'
    : '<span class="muted">empty — rebuild the search index (Sessions page) to populate</span>';
  root.innerHTML =
    '<div class="card"><h2>Quota HUD (estimate)</h2>' +
    'window 5h: <b>' + u.currentWindow.sessions + '</b> sessions · week: <b>' + u.week.sessions + '</b> sessions' +
    '<div class="muted">' + esc(u.label) + ' · ' + esc(u.officialSource) + '</div></div>' +
    alerts.alerts.map((a) => '<div class="card ' + (a.level === 'warn' ? 'warn-yellow' : 'ok') + '">' + esc(a.message) + '</div>').join('') +
    (full
      ? '<div class="card"><h2>By day</h2>' + tab(full.byDay, 'day', 'sessions') + '</div>' +
        '<div class="card"><h2>By project</h2>' + tab(full.byProject, 'projectKey', 'sessions') + '</div>' +
        '<div class="card"><h2>By model</h2>' + tab(full.byModel, 'model', 'sessions') + '</div>' +
        '<div class="muted">' + esc(full.label) + '</div>'
      : '');
};

// ---- F-Act ----
pages.activity = async (root) => {
  root.innerHTML =
    '<div class="card"><h2>Activity feed</h2>' +
    '<div class="row"><label><input type="checkbox" id="consent"> I consent to installing hooks into settings.json</label>' +
    '<button class="primary" id="install">Install feed hooks</button><button id="uninstall">Uninstall</button></div>' +
    '<div class="muted">Hooks are fail-open with a 2s timeout — a stopped console never blocks the CLI.</div></div>' +
    '<div class="card"><h2>Live events</h2><table id="feed"><tr><th>#</th><th>Time</th><th>Event</th></tr></table></div>';
  const row = (e) => {
    const b = e.body || {};
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + e.seq + '</td><td class="muted">' + new Date(e.ts).toLocaleTimeString() + '</td>' +
      '<td>' + esc(b.hook_event_name || JSON.stringify(b).slice(0, 120)) + (b.tool_name ? ' · <b>' + esc(b.tool_name) + '</b>' : '') + '</td>';
    const t = $('#feed');
    t.insertBefore(tr, t.rows[1] || null);
    while (t.rows.length > 60) t.deleteRow(-1);
  };
  try { (await api('/api/events/recent')).events.slice(-30).forEach(row); } catch (e) { fail(e); }
  const es = new EventSource('/api/events/feed');
  es.onmessage = (m) => row(JSON.parse(m.data));
  window.addEventListener('hashchange', () => es.close(), { once: true });
  $('#install').onclick = async () => {
    try {
      await api('/api/activity/hooks/install', { method: 'POST', body: { scope: 'project', dir: getProject() || undefined, consent: $('#consent').checked } });
      savedToast('Feed hooks active for new sessions.');
    } catch (e) { fail(e); }
  };
  $('#uninstall').onclick = async () => {
    try { const r = await api('/api/activity/hooks/uninstall', { method: 'POST', body: { scope: 'project', dir: getProject() || undefined } });
      toast('Removed ' + r.removed + ' hook entries', 'ok'); } catch (e) { fail(e); }
  };
};

// ---- F-Loop ----
pages.loop = async (root) => {
  root.innerHTML =
    '<div class="card"><h2>Approval queue</h2><div id="apr">loading…</div></div>' +
    '<div class="card"><h2>Steer a running task</h2>' +
    '<div class="row"><input type="text" id="taskId" placeholder="task id" size="18"></div>' +
    '<textarea id="guidance" placeholder="guidance for the task (injected as marked data, never executed)"></textarea>' +
    '<div class="row"><button class="primary" id="steer">Steer</button></div></div>' +
    '<div class="card"><h2>Recent loop events</h2><pre id="events">loading…</pre></div>' +
    '<div class="card warn-red"><h2>Kill switch</h2><div class="row">' +
    '<button class="danger" id="kill">KILL loop</button>' +
    '<span class="muted">Stops the autonomous loop immediately; the event log is preserved.</span></div></div>';
  const refresh = async () => {
    try {
      const { approvals } = await api('/api/loop/approvals');
      $('#apr').innerHTML = approvals.length ? approvals.map((p) =>
        '<div class="card"><b>' + esc(p.taskId) + '</b> · risk ' + esc(p.risk ?? '?') + ' · ' + esc(p.kind ?? 'approval') +
        '<pre>' + esc(JSON.stringify(p, null, 2).slice(0, 1600)) + '</pre>' +
        '<div class="row"><button class="primary" data-v="approved" data-id="' + esc(p.id) + '">Approve</button>' +
        '<button class="danger" data-v="rejected" data-id="' + esc(p.id) + '">Reject</button></div></div>').join('')
        : '<span class="muted">no pending approvals</span>';
      const ev = await api('/api/loop/events?since=0');
      $('#events').textContent = (ev.events ?? []).slice(-30).map((e) => e.seq + ' ' + e.type + ' ' + e.taskId).join('\\n') || '(empty)';
    } catch (e) {
      $('#apr').innerHTML = '<span class="muted">' + esc(e.message) + ' — start a loop first (Scheduler or scripts/run-*.mjs)</span>';
      $('#events').textContent = '(loop not running)';
    }
  };
  $('#apr').onclick = async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    try { await api('/api/loop/approvals/' + b.dataset.id, { method: 'POST', body: { verdict: b.dataset.v } }); toast('Decision recorded: ' + b.dataset.v, 'ok'); refresh(); }
    catch (e) { fail(e); }
  };
  $('#steer').onclick = async () => {
    try { await api('/api/loop/steer', { method: 'POST', body: { taskId: $('#taskId').value, guidance: $('#guidance').value } });
      toast('Guidance injected as marked data', 'ok'); } catch (e) { fail(e); }
  };
  $('#kill').onclick = async () => {
    if (!confirm('KILL the autonomous loop now?')) return;
    try { await api('/api/loop/kill', { method: 'POST', body: {} }); toast('Kill signal sent', 'ok'); } catch (e) { fail(e); }
  };
  await refresh();
};

// ---- F-Sched ----
pages.sched = async (root) => {
  const { jobs } = await api('/api/sched');
  const guard = await api('/api/guards/automation');
  root.innerHTML =
    '<div class="card ' + (guard.allowed ? 'ok' : 'warn-yellow') + '"><h2>Automation guard</h2>' +
    'utilization ' + Math.round(guard.utilization * 100) + '% / threshold ' + Math.round(guard.threshold * 100) + '% — ' +
    (guard.allowed ? 'automation allowed' : 'over threshold: new jobs defer until reset (interactive keeps priority)') + '</div>' +
    '<div class="card"><h2>Jobs</h2>' +
    (jobs.length ? '<table>' + jobs.map((j) => '<tr><td>' + esc(j) + '</td><td><button class="danger" data-j="' + esc(j) + '">stop</button></td></tr>').join('') + '</table>'
      : '<span class="muted">none running</span>') + '</div>' +
    '<div class="card"><h2>Start opaque job</h2>' +
    '<div class="row"><input type="text" id="jname" placeholder="name" size="14">' +
    '<input type="text" id="jcmd" placeholder="command e.g. ./scripts/calibrate.sh" size="34"><button class="primary" id="jstart">Start</button></div>' +
    '<div class="muted">Start/stop only — task scheduling and leases belong to the core, not the console.</div></div>';
  $('#jstart').onclick = async () => {
    try { await api('/api/sched/start', { method: 'POST', body: { name: $('#jname').value, cmd: $('#jcmd').value } }); toast('Started', 'ok'); route(); }
    catch (e) { fail(e); }
  };
  root.onclick = async (ev) => {
    const b = ev.target.closest('button.danger'); if (!b) return;
    try { await api('/api/sched/stop', { method: 'POST', body: { name: b.dataset.j } }); route(); } catch (e) { fail(e); }
  };
};

// ---- F-Sys ----
pages.system = async (root) => {
  const s = await api('/api/system');
  const gb = (n) => (n / 1073741824).toFixed(1) + ' GB';
  root.innerHTML =
    '<div class="card"><h2>Doctor</h2><pre>' + esc(typeof s.doctor === 'string' ? s.doctor : JSON.stringify(s.doctor, null, 2)) + '</pre></div>' +
    '<div class="card"><h2>Host</h2><table>' +
    '<tr><th>loadavg</th><td>' + s.host.loadavg.map((x) => x.toFixed(2)).join(' / ') + '</td></tr>' +
    '<tr><th>memory</th><td>' + gb(s.host.freemem) + ' free of ' + gb(s.host.totalmem) + '</td></tr></table></div>' +
    '<div class="card"><h2>Retention</h2>' +
    '<div class="row"><label>cleanupPeriodDays</label>' +
    '<input type="number" id="days" value="' + (s.retention.cleanupPeriodDays ?? '') + '" placeholder="(unset)" min="1" max="3650">' +
    '<button class="primary" id="saveRet">Save</button></div>' +
    '<div class="card warn-yellow">' + esc(s.retention.warning) + '</div></div>';
  $('#saveRet').onclick = async () => {
    const v = $('#days').value;
    if (!confirm('Change transcript retention to ' + (v || 'unset') + ' days? Lowering it deletes old transcripts.')) return;
    try { const r = await api('/api/system/retention', { method: 'PUT', body: { cleanupPeriodDays: v ? Number(v) : null } });
      savedToast(r.warning); } catch (e) { fail(e); }
  };
};

// ---- router ----
async function route() {
  const page = (location.hash.replace(/^#\\//, '') || 'status').split('?')[0];
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#/' + page));
  const main = $('#main');
  main.innerHTML = (await projectBar()) + '<div id="page">loading…</div>';
  const sel = $('#projsel');
  if (sel) sel.onchange = () => setProject(sel.value);
  try { await (pages[page] || pages.status)($('#page')); }
  catch (e) { if (String(e.message) !== 'unauthorized') $('#page').innerHTML = '<div class="card warn-red">' + esc(e.message) + '</div>'; }
}
window.addEventListener('hashchange', route);
route();
</script>
</body>
</html>`;
