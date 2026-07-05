// Console SPA (§8): one page, hash-routed, every F-* surface wired to its REST endpoint.
// Static string — no server-side interpolation; all API data is escaped client-side.
export const INDEX_HTML: string = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Platform Console</title>
<style>
  :root {
    --bg:#f6f7f9; --surface:#ffffff; --fg:#111827; --muted:#6b7280; --line:#e5e7eb;
    --accent:#4f46e5; --accent-fg:#ffffff; --accent-soft:#eef2ff;
    --red:#b91c1c; --red-soft:#fef2f2; --red-line:#fecaca;
    --yellow:#854d0e; --yellow-soft:#fefce8; --yellow-line:#fde68a;
    --green:#15803d; --green-soft:#f0fdf4; --green-line:#bbf7d0;
    --shadow:0 1px 2px rgb(16 24 40 / .06), 0 1px 3px rgb(16 24 40 / .1);
    --radius:10px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0b0e14; --surface:#151a23; --fg:#e5e7eb; --muted:#94a3b8; --line:#252c3a;
      --accent:#818cf8; --accent-fg:#0b0e14; --accent-soft:#1e2340;
      --red:#fca5a5; --red-soft:#2a1414; --red-line:#7f1d1d;
      --yellow:#fde047; --yellow-soft:#2a2410; --yellow-line:#713f12;
      --green:#86efac; --green-soft:#0f2a1a; --green-line:#14532d;
      --shadow:none;
    }
  }
  * { box-sizing:border-box; }
  html { scrollbar-gutter: stable; }
  body { margin:0; font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background:var(--bg); color:var(--fg); }
  a { color:var(--accent); text-decoration:none; }
  code { font:12px ui-monospace, Menlo, monospace; background:var(--accent-soft); padding:1px 5px; border-radius:5px; }

  /* ---- shell ---- */
  #layout { display:flex; min-height:100vh; }
  #nav { width:232px; flex-shrink:0; border-right:1px solid var(--line); background:var(--surface);
         position:sticky; top:0; height:100vh; overflow-y:auto; padding:14px 10px; }
  #brand { display:flex; align-items:center; gap:10px; padding:4px 10px 12px; }
  #brand .logo { width:30px; height:30px; border-radius:8px; background:var(--accent); color:var(--accent-fg);
                 display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; }
  #brand b { font-size:14px; display:block; }
  #brand .sub { font-size:10.5px; color:var(--muted); }
  #nav .grp { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.09em;
              color:var(--muted); margin:14px 12px 4px; }
  #nav a.item { display:flex; align-items:center; gap:9px; padding:6px 10px; margin:1px 0;
                border-radius:8px; color:var(--fg); font-size:13px; }
  #nav a.item svg { width:15px; height:15px; stroke:var(--muted); flex-shrink:0; }
  #nav a.item:hover { background:var(--bg); }
  #nav a.item.on { background:var(--accent-soft); color:var(--accent); font-weight:600; }
  #nav a.item.on svg { stroke:var(--accent); }

  #main { flex:1; min-width:0; }
  #topbar { position:sticky; top:0; z-index:5; display:flex; gap:12px; align-items:center;
            padding:10px 26px; background:var(--bg); border-bottom:1px solid var(--line); }
  #topbar h1 { font-size:16px; margin:0; flex-shrink:0; }
  #topbar .spacer { flex:1; }
  #content { padding:20px 26px 60px; max-width:1120px; }

  #menuBtn { display:none; }
  @media (max-width: 900px) {
    #nav { position:fixed; z-index:20; left:0; transform:translateX(-100%); transition:transform .18s ease; }
    #nav.open { transform:none; box-shadow:0 0 40px rgb(0 0 0 / .35); }
    #menuBtn { display:inline-flex; }
    #topbar { padding:10px 14px; flex-wrap:wrap; }
    #projsel { max-width:46vw; }
    #content { padding:16px 14px 60px; }
    .card { overflow-x:auto; }
  }

  /* ---- components ---- */
  .card { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius);
          padding:16px 18px; margin:0 0 14px; box-shadow:var(--shadow); }
  .card h2 { font-size:13.5px; font-weight:650; margin:0 0 10px; display:flex; align-items:center; gap:8px; }
  .grid2 { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:14px; margin:0 0 14px; }
  .grid2 .card { margin:0; }
  .muted { color:var(--muted); font-size:12px; }
  .kpi { font-size:22px; font-weight:700; letter-spacing:-.02em; }
  .kpi small { font-size:12px; font-weight:400; color:var(--muted); margin-left:4px; }

  .banner { display:flex; gap:10px; align-items:flex-start; border:1px solid var(--line);
            border-radius:var(--radius); padding:11px 14px; margin:0 0 12px; font-size:13px; }
  .banner.red { background:var(--red-soft); border-color:var(--red-line); color:var(--red); }
  .banner.yellow { background:var(--yellow-soft); border-color:var(--yellow-line); color:var(--yellow); }
  .banner.green { background:var(--green-soft); border-color:var(--green-line); color:var(--green); }

  .pill { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:600;
          border:1px solid var(--line); border-radius:99px; padding:1.5px 9px; background:var(--bg); }
  .pill .dot { width:6px; height:6px; border-radius:99px; background:var(--muted); }
  .pill.green { color:var(--green); border-color:var(--green-line); background:var(--green-soft); }
  .pill.green .dot { background:var(--green); }
  .pill.yellow { color:var(--yellow); border-color:var(--yellow-line); background:var(--yellow-soft); }
  .pill.yellow .dot { background:var(--yellow); }

  select, input[type=text], input[type=number], input[type=password], textarea {
    font:13px/1.5 ui-monospace, Menlo, monospace; color:var(--fg); background:var(--surface);
    border:1px solid var(--line); border-radius:8px; padding:6px 10px; max-width:100%;
    transition:border-color .12s; }
  select { font-family:inherit; }
  :is(select, input, textarea):focus { outline:none; border-color:var(--accent); }
  :is(button, a, select, input, textarea):focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  textarea { width:100%; min-height:150px; resize:vertical; }

  button { display:inline-flex; align-items:center; gap:6px; font:13px/1.2 inherit; font-weight:550;
           padding:6.5px 13px; border-radius:8px; border:1px solid var(--line); background:var(--surface);
           color:var(--fg); cursor:pointer; transition:background .12s, border-color .12s, opacity .12s; }
  button:hover { background:var(--bg); }
  button.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
  button.primary:hover { opacity:.88; }
  button.danger { color:var(--red); border-color:var(--red-line); background:transparent; }
  button.danger:hover { background:var(--red-soft); }
  button.ghost { border-color:transparent; background:transparent; color:var(--muted); padding:6px 9px; font-size:12px; min-height:30px; }
  button.ghost:hover { background:var(--bg); color:var(--fg); }
  button.ghost.danger { color:var(--red); }
  button:disabled { opacity:.5; cursor:default; }

  table { border-collapse:collapse; width:100%; font-size:13px; }
  th { text-align:left; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.06em;
       color:var(--muted); padding:6px 12px 6px 0; border-bottom:1px solid var(--line); }
  td { text-align:left; padding:7px 12px 7px 0; border-bottom:1px solid var(--line); vertical-align:middle; }
  tbody tr:hover td, table.hover tr:not(:first-child):hover td { background:color-mix(in srgb, var(--accent) 4%, transparent); }
  tr:last-child td { border-bottom:none; }

  pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px;
        overflow:auto; font-size:12px; line-height:1.55; max-height:420px; margin:8px 0; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:8px 0; }
  .row label { font-size:12px; color:var(--muted); font-weight:600; }

  .empty { text-align:center; padding:26px 10px; color:var(--muted); font-size:13px; }
  .empty .big { font-size:22px; display:block; margin-bottom:6px; opacity:.5; }

  .skel { border-radius:6px; height:13px; margin:9px 0;
          background:linear-gradient(90deg, var(--line), color-mix(in srgb, var(--line) 40%, transparent), var(--line));
          background-size:200% 100%; animation:sh 1.1s linear infinite; }
  @keyframes sh { from { background-position:200% 0; } to { background-position:-200% 0; } }

  #toast { position:fixed; bottom:18px; right:18px; max-width:430px; z-index:60; }
  #toast .t { display:flex; gap:8px; border-radius:10px; padding:11px 15px; margin-top:8px;
              border:1px solid var(--line); border-left:3px solid var(--muted); background:var(--surface);
              box-shadow:0 8px 24px rgb(0 0 0 / .18); font-size:13px; animation:slidein .16s ease; }
  #toast .t.green { border-left-color:var(--green); }
  #toast .t.red { border-left-color:var(--red); }
  @keyframes slidein { from { transform:translateY(8px); opacity:0; } }

  #overlay { position:fixed; inset:0; background:rgb(0 0 0 / .45); z-index:50;
             display:flex; align-items:center; justify-content:center; padding:16px; }
  #overlay .modal { background:var(--surface); border:1px solid var(--line); border-radius:14px;
                    box-shadow:0 20px 60px rgb(0 0 0 / .3); width:100%; max-width:440px; padding:20px 22px;
                    animation:pop .14s ease; }
  @keyframes pop { from { transform:scale(.96); opacity:0; } }
  #overlay h3 { margin:0 0 6px; font-size:15px; }
  #overlay p { margin:0 0 14px; color:var(--muted); font-size:13px; }
  #overlay input[type=text] { width:100%; margin-bottom:14px; }
  #overlay .btns { display:flex; justify-content:flex-end; gap:8px; }
</style>
</head>
<body>
<div id="layout">
  <nav id="nav"></nav>
  <div id="main">
    <div id="topbar">
      <button id="menuBtn" class="ghost" aria-label="menu">☰</button>
      <h1 id="pageTitle" tabindex="-1" style="outline:none">Console</h1>
      <div class="spacer"></div>
      <label class="muted" for="projsel">Project</label>
      <select id="projsel" style="max-width:340px"></select>
      <button class="primary" id="quickTerm" title="Open a real claude terminal">⌨ Terminal</button>
    </div>
    <div id="content"></div>
  </div>
</div>
<div id="toast" role="status" aria-live="polite"></div>
<script>
'use strict';
const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ---- icons (inline stroke SVG, no external assets) ----
const icon = (d) => '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';
const ICONS = {
  status: 'M22 12h-4l-3 9L9 3l-3 9H2',
  projects: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  sessions: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  chat: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z',
  usage: 'M12 20V10M18 20V4M6 20v-4',
  activity: 'M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16M5 20a1 1 0 1 0 0-1',
  loop: 'M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3',
  sched: 'M12 8v4l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  permissions: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  auth: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  memory: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5z',
  mcp: 'M9 2v6M15 2v6M9 22v-3M15 22v-3M5 8h14a1 1 0 0 1 1 1v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z',
  hooks: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  subagents: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  skills: 'M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z',
  system: 'M14.7 6.3a5 5 0 0 0-6.6 6.6L3 18l3 3 5.1-5.1a5 5 0 0 0 6.6-6.6L14 12l-2-2z',
};
const NAV = [
  { group: 'Operate', items: [
    ['status', 'Status'], ['projects', 'Projects'], ['sessions', 'Sessions'],
    ['terminal', 'Terminal'], ['chat', 'Chat'], ['usage', 'Usage & Quota'], ['activity', 'Activity Feed'] ] },
  { group: 'Autonomous', items: [ ['loop', 'Loop Console'], ['sched', 'Scheduler'] ] },
  { group: 'Govern', items: [
    ['settings', 'Settings'], ['permissions', 'Permissions'], ['auth', 'Auth & Env'], ['memory', 'Memory'] ] },
  { group: 'Extend', items: [
    ['mcp', 'MCP'], ['hooks', 'Hooks'], ['subagents', 'Subagents'], ['skills', 'Skills & Plugins'] ] },
  { group: 'Maintain', items: [ ['system', 'System & Retention'] ] },
];
const TITLES = {};
$('#nav').innerHTML =
  '<div id="brand"><div class="logo">P</div><div><b>Platform Console</b>' +
  '<span class="sub" id="disclaimer">operator console</span></div></div>' +
  NAV.map((g) => '<div class="grp">' + g.group + '</div>' + g.items.map(([id, label]) => {
    TITLES[id] = label;
    return '<a class="item" data-p="' + id + '" href="#/' + id + '">' + icon(ICONS[id]) + esc(label) + '</a>';
  }).join('')).join('');

// ---- tiny UI kit ----
const toast = (msg, cls) => {
  const d = document.createElement('div');
  d.className = 't ' + (cls || '');
  d.textContent = msg;
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), cls === 'red' ? 10000 : 6000); // errors linger longer
};
// Apply-timing is communicated on every save (§8)
const savedToast = (note) => toast('Saved. ' + (note || 'Applies to new sessions; running sessions keep their config.'), 'green');
const IGNORED = new Set(['stale', 'unauthorized']);
const fail = (e) => { if (!IGNORED.has(String(e.message))) toast(String(e.message || e), 'red'); };

function modal(html, onCancel) {
  const prev = document.activeElement;
  const o = document.createElement('div');
  o.id = 'overlay';
  o.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>';
  document.body.appendChild(o);
  const close = () => {
    o.remove();
    document.removeEventListener('keydown', onKey, true);
    if (prev && prev.focus) prev.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    if (e.key === 'Tab') { // minimal focus trap: keep Tab inside the dialog
      const f = [...o.querySelectorAll('button, input')];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  return { o, close };
}
const confirmDialog = (title, body, opts) => new Promise((res) => {
  const done = (ok) => { close(); res(ok); };
  const { o, close } = modal(
    '<h3>' + esc(title) + '</h3><p>' + esc(body) + '</p><div class="btns">' +
    '<button data-x="0">Cancel</button>' +
    '<button class="' + ((opts && opts.danger) ? 'danger' : 'primary') + '" data-x="1">' + esc((opts && opts.action) || 'Confirm') + '</button></div>',
    () => done(false));
  o.querySelector('[data-x="1"]').focus();
  o.onclick = (e) => {
    if (e.target === o) return done(false);
    const b = e.target.closest('button');
    if (b) done(b.dataset.x === '1');
  };
});
const promptDialog = (title, body, value) => new Promise((res) => {
  const done = (ok) => { const v = input.value; close(); res(ok ? v : null); };
  const { o, close } = modal(
    '<h3>' + esc(title) + '</h3><p>' + esc(body || '') + '</p>' +
    '<input type="text" id="mval" aria-label="' + esc(title) + '" value="' + esc(value || '') + '"><div class="btns">' +
    '<button data-x="0">Cancel</button><button class="primary" data-x="1">OK</button></div>',
    () => done(false));
  const input = $('#mval', o);
  input.focus(); input.select();
  input.onkeydown = (e) => { if (e.key === 'Enter') done(true); };
  o.onclick = (e) => {
    if (e.target === o) return done(false);
    const b = e.target.closest('button');
    if (b) done(b.dataset.x === '1');
  };
});
const skeleton = (n) => Array.from({ length: n || 3 }, (_, i) =>
  '<div class="skel" style="width:' + (88 - i * 14) + '%"></div>').join('');
const empty = (msg, hint) => '<div class="empty"><span class="big">◌</span>' + esc(msg) +
  (hint ? '<div class="muted" style="margin-top:4px">' + esc(hint) + '</div>' : '') + '</div>';
const ago = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};

let gen = 0; // navigation generation: stale async continuations must never touch the new page's DOM
async function api(url, opts) {
  const g = gen;
  const r = await fetch(url, opts && opts.body != null
    ? { ...opts, headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body) }
    : opts);
  if (g !== gen) throw new Error('stale'); // navigated away mid-flight — abandon this continuation
  if (r.status === 401) { renderLogin(); throw new Error('unauthorized'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || (url + ' -> HTTP ' + r.status));
  return data;
}

// ---- project context: ?project=<path> is deep-linkable on every page (§8) ----
const getProject = () => new URLSearchParams(location.search).get('project') || '';
const setProjectQuiet = (p) => { // update the query param without re-routing (caller navigates next)
  const q = new URLSearchParams(location.search);
  if (p) q.set('project', p); else q.delete('project');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
};
const setProject = (p) => { setProjectQuiet(p); route(); };
const dirQ = () => { const p = getProject(); return p ? '?dir=' + encodeURIComponent(p) : ''; };
const dirAmp = () => { const p = getProject(); return p ? '&dir=' + encodeURIComponent(p) : ''; };

function renderLogin() {
  if ($('#pw')) return; // already showing — never wipe the password while the user types
  for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* noop */ } } // stop background pollers
  $('#content').innerHTML =
    '<div class="card" style="max-width:380px;margin:8vh auto"><h2>Sign in</h2>' +
    '<p class="muted">Remote auth is enabled (fail-closed, single operator).</p>' +
    '<div class="row"><input type="password" id="pw" aria-label="operator password" placeholder="operator password" style="flex:1">' +
    '<button class="primary" id="loginBtn">Login</button></div></div>';
  const go = async () => {
    try { await api('/api/auth/login', { method: 'POST', body: { password: $('#pw').value } }); location.reload(); }
    catch (e) { fail(e); }
  };
  $('#loginBtn').onclick = go;
  $('#pw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

async function fillProjectBar() {
  const sel = $('#projsel');
  try {
    const { projects } = await api('/api/projects');
    sel.innerHTML = '<option value="">All projects (server cwd)</option>' + projects.map((p) =>
      '<option value="' + esc(p.path) + '"' + (p.path === getProject() ? ' selected' : '') + '>' +
      esc(p.path) + (p.loopManaged ? '  ·  loop-managed' : '') + '</option>').join('');
  } catch { /* login flow handles 401 */ }
}
$('#projsel').onchange = () => setProject($('#projsel').value);
$('#quickTerm').onclick = () => window.open('/terminal?project=' + encodeURIComponent(getProject() || ''), '_blank');
$('#menuBtn').onclick = (e) => { e.stopPropagation(); $('#nav').classList.toggle('open'); };
$('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) $('#nav').classList.remove('open'); });
document.addEventListener('click', (e) => { // outside-click closes the mobile drawer
  if (!e.target.closest('#nav')) $('#nav').classList.remove('open');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#nav').classList.remove('open'); });

const pages = {};
let cleanups = [];
const onLeave = (fn) => cleanups.push(fn);
const every = (fn, ms) => { const t = setInterval(fn, ms); cleanups.push(() => clearInterval(t)); };

// ---- F-Status ----
pages.status = async (root) => {
  const render = async () => {
    const st = await api('/api/status');
    const term = await api('/api/term').catch(() => ({ terminals: [] }));
    const usage = await api('/api/usage');
    $('#disclaimer').textContent = st.disclaimer;
    root.innerHTML =
      st.auth.warnings.map((w) => '<div class="banner ' + (w.severity === 'red' ? 'red' : 'yellow') + '"><b>' + esc(w.variable) + '</b> ' + esc(w.message) + '</div>').join('') +
      '<div class="grid2">' +
      '<div class="card"><h2>CLI</h2><div class="kpi" style="font-size:16px">' + esc(st.cli) + '</div>' +
      '<div class="muted" style="margin-top:6px">auth: ' + esc(st.auth.method) + '</div></div>' +
      '<div class="card"><h2>Quota (estimate)</h2><div class="kpi">' + usage.currentWindow.sessions + '<small>sessions / 5h window</small></div>' +
      '<div class="kpi" style="font-size:16px;margin-top:4px">' + usage.week.sessions + '<small>sessions / week</small></div>' +
      '<div class="muted" style="margin-top:6px">' + esc(usage.officialSource) + '</div></div>' +
      '<div class="card"><h2>Active terminals</h2><div class="kpi">' + term.terminals.length + '<small>PTY</small></div>' +
      '<div class="muted" style="margin-top:6px">interactive runs (mode: both surfaces below)</div></div>' +
      (function () { var a = (st.runs && st.runs.autonomous) || { running: false };
        return '<div class="card"><h2>Autonomous loop</h2>' +
          (a.running
            ? '<div class="kpi">' + (a.pendingApprovals || 0) + '<small>pending approvals</small></div>' +
              '<div class="muted" style="margin-top:6px">last event #' + (a.lastEventSeq || 0) + ' · <a href="#/loop">Loop Console →</a></div>'
            : '<div class="kpi" style="font-size:16px">not running</div><div class="muted" style="margin-top:6px">' + esc(a.reason || 'no loop') + '</div>') +
          '</div>'; })() +
      '</div>' +
      '<div class="card"><h2>Active runs (interactive)</h2>' +
      (term.terminals.length
        ? '<table><tr><th>ID</th><th>Directory</th><th></th></tr>' + term.terminals.map((t) =>
            '<tr><td><code>' + esc(t.id) + '</code></td><td class="muted">' + esc(t.cwd) + '</td>' +
            '<td><a target="_blank" href="/terminal?attach=' + esc(t.id) + '">attach →</a></td></tr>').join('') + '</table>'
        : empty('No interactive terminals', 'Spawn one from the Terminal page or the ⌨ button above')) +
      '</div>' +
      '<div class="card"><h2>Doctor (brief)</h2><pre>' + esc(st.doctorBrief || 'loading… (cached 60s)') + '</pre>' +
      '<div class="muted">Full doctor + host stats on the System page.</div></div>';
  };
  root.innerHTML = '<div class="card">' + skeleton(4) + '</div>';
  await render();
  // skip refresh while the operator is interacting inside the page (focus would be wiped)
  every(() => { if (!root.contains(document.activeElement)) render().catch(fail); }, 12000);
};

// ---- F-Proj ----
pages.projects = async (root) => {
  const { projects } = await api('/api/projects');
  root.innerHTML =
    '<div class="card"><h2>Register directory</h2><div class="row">' +
    '<input type="text" id="regdir" aria-label="directory path" placeholder="/absolute/path" style="flex:1;max-width:520px">' +
    '<button class="primary" id="regbtn">Register</button></div>' +
    '<div class="muted">Creates the project entry the CLI uses under ~/.claude/projects.</div></div>' +
    '<div class="card"><h2>Projects <span class="pill">' + projects.length + '</span></h2>' +
    (projects.length ? '<table><tr><th>Path</th><th></th></tr>' +
      projects.map((p) =>
        '<tr><td><a href="#/sessions" data-proj="' + esc(p.path) + '">' + esc(p.path) + '</a></td>' +
        '<td>' + (p.loopManaged ? '<span class="pill yellow"><span class="dot"></span>loop-managed</span>' : '') + '</td></tr>').join('') +
      '</table>' : empty('No projects registered yet')) + '</div>';
  $('#regbtn').onclick = async () => {
    try { const r = await api('/api/projects/register', { method: 'POST', body: { dir: $('#regdir').value } });
      toast('Registered as ' + r.key, 'green'); route(); } catch (e) { fail(e); }
  };
  root.onclick = (ev) => {
    const a = ev.target.closest('a[data-proj]');
    if (!a) return;
    ev.preventDefault(); // let the hash assignment below fire route() exactly once
    setProjectQuiet(a.dataset.proj);
    location.hash = '#/sessions';
  };
};

// ---- F-Sess ----
pages.sessions = async (root) => {
  root.innerHTML = '<div class="card">' + skeleton(6) + '</div>';
  const { sessions } = await api('/api/sessions?limit=50' + dirAmp());
  const rowsHtml = (list) => list.length ? list.map((s) =>
    '<tr data-id="' + esc(s.sessionId) + '" data-cwd="' + esc(s.cwd || '') + '">' +
    '<td><a href="javascript:void 0" data-act="resume" title="Resume in terminal">' +
    esc((s.customTitle || s.summary || s.firstPrompt || s.sessionId).slice(0, 70)) + '</a></td>' +
    '<td>' + (s.tag ? '<span class="pill">' + esc(s.tag) + '</span>' : '') + '</td>' +
    '<td class="muted" title="' + new Date(s.lastModified).toLocaleString() + '">' + ago(s.lastModified) + '</td>' +
    '<td style="white-space:nowrap">' +
    '<button class="ghost" data-act="resume">resume</button>' +
    '<button class="ghost" data-act="rename">rename</button><button class="ghost" data-act="tag">tag</button>' +
    '<button class="ghost" data-act="fork">fork</button><button class="ghost" data-act="export">export</button>' +
    '<button class="ghost danger" data-act="del">delete</button>' +
    '</td></tr>').join('') : '<tr><td colspan="4">' + empty('No sessions here yet') + '</td></tr>';
  root.innerHTML =
    '<div class="card"><h2>Search transcripts</h2><div class="row">' +
    '<input type="text" id="q" aria-label="search text" placeholder="full-text search… (press Enter)" style="flex:1;max-width:420px">' +
    '<button id="qbtn" class="primary">Search</button>' +
    '<button id="reindex">Rebuild index</button><span class="muted" id="idxstate"></span></div>' +
    '<div id="hits"></div></div>' +
    '<div class="card"><h2>Sessions</h2>' +
    '<div class="row"><input type="text" id="filter" aria-label="filter sessions" placeholder="filter list (e.g. loop:)" style="max-width:260px"></div>' +
    '<table id="sesstab"><tr><th>Title</th><th>Tag</th><th>When</th><th style="text-align:right">Actions</th></tr>' + rowsHtml(sessions) + '</table></div>';

  $('#filter').oninput = () => {
    const f = $('#filter').value.toLowerCase();
    const filtered = sessions.filter((s) =>
      !f || (s.tag || '').toLowerCase().startsWith(f) ||
      JSON.stringify([s.summary, s.customTitle, s.firstPrompt]).toLowerCase().includes(f));
    $('#sesstab').innerHTML = '<tr><th>Title</th><th>Tag</th><th>When</th><th style="text-align:right">Actions</th></tr>' + rowsHtml(filtered);
  };
  const doSearch = async () => {
    try {
      const { hits } = await api('/api/sessions/search?q=' + encodeURIComponent($('#q').value));
      $('#hits').innerHTML = hits.length
        ? '<table>' + hits.map((h) => '<tr><td>' + esc(h.snippet) + '</td><td class="muted" style="white-space:nowrap">' +
          esc(h.sessionId.slice(0, 8)) + ' · ' + ago(h.lastModified) + '</td></tr>').join('') + '</table>'
        : empty('No hits', 'Rebuild the index if transcripts are new');
    } catch (e) { fail(e); }
  };
  $('#qbtn').onclick = doSearch;
  $('#q').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  $('#reindex').onclick = async () => {
    try {
      const { actionId } = await api('/api/sessions/search/index', { method: 'POST' });
      $('#idxstate').textContent = 'indexing…';
      const poll = setInterval(async () => {
        const a = await api('/api/actions/' + actionId + '/status');
        if (a.status !== 'running') {
          clearInterval(poll);
          $('#idxstate').textContent = a.status === 'done'
            ? 'indexed ' + a.result.indexed + ' of ' + a.result.total : 'error: ' + a.error;
        }
      }, 700);
      onLeave(() => clearInterval(poll));
    } catch (e) { fail(e); }
  };
  $('#sesstab').onclick = async (ev) => {
    const el = ev.target.closest('[data-act]'); if (!el) return;
    const tr = ev.target.closest('tr');
    const id = tr.dataset.id, cwd = tr.dataset.cwd;
    const acts = {
      resume: () => window.open('/terminal?project=' + encodeURIComponent(cwd || getProject() || '') + '&resume=' + id, '_blank'),
      rename: async () => { const t = await promptDialog('Rename session', 'New display title', ''); if (t) { await api('/api/sessions/' + id + '/rename', { method: 'POST', body: { title: t } }); route(); } },
      tag: async () => { const t = await promptDialog('Tag session', 'Empty clears the tag', ''); if (t !== null) { await api('/api/sessions/' + id + '/tag', { method: 'POST', body: { tag: t || null } }); route(); } },
      fork: async () => { const r = await api('/api/sessions/' + id + '/fork', { method: 'POST', body: {} }); toast('Forked → ' + r.sessionId, 'green'); route(); },
      export: () => { location.href = '/api/sessions/' + id + '/export'; },
      del: async () => {
        if (await confirmDialog('Delete session?', 'The transcript file ' + id.slice(0, 8) + '… is removed from disk.', { danger: true, action: 'Delete' })) {
          await api('/api/sessions/' + id, { method: 'DELETE' }); route();
        }
      },
    };
    try { await acts[el.dataset.act](); } catch (e) { fail(e); }
  };
};

// ---- F-Term ----
pages.terminal = async (root) => {
  const { terminals } = await api('/api/term');
  const usage = await api('/api/usage').catch(() => null); // INV-13: quota HUD, fail-open
  root.innerHTML =
    (usage ? '<div class="banner ' + (usage.currentWindow.sessions >= 40 ? 'yellow' : 'green') + '"><b>Quota estimate</b> ~' +
      usage.currentWindow.sessions + ' sessions in the 5h window · ' + esc(usage.officialSource) + '</div>' : '') +
    '<div class="card"><h2>New terminal</h2>' +
    '<div class="row"><button class="primary" id="spawn">⌨ Spawn claude</button>' +
    '<span class="muted">real CLI via PTY (100% parity) · cwd = ' + esc(getProject() || 'server cwd') + '</span></div>' +
    '<div class="muted">Opens in a new tab. Closing the tab detaches — the session keeps running.</div></div>' +
    '<div class="card"><h2>Running terminals <span class="pill">' + terminals.length + '</span></h2>' +
    (terminals.length ? '<table><tr><th>ID</th><th>Directory</th><th></th><th></th></tr>' + terminals.map((t) =>
      '<tr><td><code>' + esc(t.id) + '</code></td><td class="muted">' + esc(t.cwd) + '</td>' +
      '<td><a target="_blank" href="/terminal?attach=' + esc(t.id) + '">attach →</a></td>' +
      '<td style="text-align:right"><button class="ghost danger" data-id="' + esc(t.id) + '">kill</button></td></tr>').join('') + '</table>'
      : empty('No running terminals', 'Spawn one to get the full claude CLI in the browser')) + '</div>';
  $('#spawn').onclick = () => window.open('/terminal?project=' + encodeURIComponent(getProject() || ''), '_blank');
  root.onclick = async (ev) => {
    const b = ev.target.closest('button[data-id]'); if (!b) return;
    if (await confirmDialog('Kill terminal?', b.dataset.id + ' — the CLI process is terminated.', { danger: true, action: 'Kill' })) {
      try { await api('/api/term/' + b.dataset.id, { method: 'DELETE' }); route(); } catch (e) { fail(e); }
    }
  };
};

// ---- F-Chat (management; the live chat is the standalone /chat page in a new tab) ----
pages.chat = async (root) => {
  const { chats } = await api('/api/chat').catch(() => ({ chats: [] }));
  root.innerHTML =
    '<div class="card"><h2>New chat</h2>' +
    '<div class="row"><button class="primary" id="newchat">💬 Start chat</button>' +
    '<span class="muted">sandboxed read-only claude (Read + reason; no exec) · cwd = ' + esc(getProject() || 'server cwd') + '</span></div>' +
    '<div class="muted">Opens in a new tab. Closing the tab ends the session. To run commands, use the Terminal.</div></div>' +
    '<div class="card"><h2>Active chats <span class="pill">' + chats.length + '</span></h2>' +
    (chats.length ? '<table><tr><th>ID</th><th>Directory</th><th></th></tr>' + chats.map((c) =>
      '<tr><td><code>' + esc(c.id) + '</code></td><td class="muted">' + esc(c.cwd) + '</td>' +
      '<td style="text-align:right"><button class="ghost danger" data-id="' + esc(c.id) + '">end</button></td></tr>').join('') + '</table>'
      : empty('No active chats', 'Start one — a sandboxed, read-only claude chat')) + '</div>';
  $('#newchat').onclick = () => window.open('/chat?project=' + encodeURIComponent(getProject() || ''), '_blank');
  root.onclick = async (ev) => {
    const b = ev.target.closest('button[data-id]'); if (!b) return;
    if (await confirmDialog('End chat?', b.dataset.id + ' — the chat session is terminated.', { danger: true, action: 'End' })) {
      try { await api('/api/chat/' + b.dataset.id, { method: 'DELETE' }); route(); } catch (e) { fail(e); }
    }
  };
};

// ---- F-Set ----
pages.settings = async (root) => {
  root.innerHTML =
    '<div class="card"><h2>Settings editor</h2>' +
    '<div class="row"><label>Scope</label><select id="scope" aria-label="scope"><option>user</option><option>project</option><option>local</option></select>' +
    '<button class="primary" id="save">Save</button><span class="muted" id="hash"></span></div>' +
    '<textarea id="body" aria-label="editor content" spellcheck="false"></textarea>' +
    '<div class="muted" id="applynote">Writes are schema-validated, hash-guarded (409 on concurrent edit) and atomic.</div></div>' +
    '<div class="card"><h2>Effective view (resolved + provenance)</h2><button id="eff">Refresh</button><pre id="effout" style="display:none"></pre></div>';
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
    try {
      $('#effout').style.display = '';
      $('#effout').textContent = JSON.stringify(await api('/api/settings/effective/view' + dirQ()), null, 2);
    } catch (e) { fail(e); }
  };
  await load();
};

// ---- F-Perm ----
pages.permissions = async (root) => {
  root.innerHTML =
    '<div class="card"><h2>Permission rules</h2>' +
    '<div class="row"><label>Scope</label><select id="scope" aria-label="scope"><option>user</option><option>project</option><option>local</option></select>' +
    '<button class="primary" id="save">Save</button></div>' +
    '<div class="row" style="align-items:stretch"><div style="flex:1;min-width:180px"><label>allow</label><textarea id="allow" placeholder="one rule per line"></textarea></div>' +
    '<div style="flex:1;min-width:180px"><label>deny</label><textarea id="deny"></textarea></div>' +
    '<div style="flex:1;min-width:180px"><label>ask</label><textarea id="ask"></textarea></div></div>' +
    '<div class="row"><button id="protect">🛡 Protect test/golden/** + worktrees/</button></div>' +
    '<div class="muted">Applies to new sessions.</div></div>' +
    '<div class="card"><h2>Merged view + simulator</h2>' +
    '<div class="row"><input type="text" id="simtool" aria-label="tool name" placeholder="tool e.g. Bash" style="width:140px">' +
    '<input type="text" id="simarg" aria-label="tool argument" placeholder="arg e.g. rm -rf" style="width:220px"><button id="sim" class="primary">Simulate</button></div>' +
    '<pre id="merged" style="display:none"></pre></div>';
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
      const r = await api(q);
      $('#merged').style.display = '';
      $('#merged').textContent = JSON.stringify(r, null, 2);
    } catch (e) { fail(e); }
  };
  await load();
};

// ---- F-Auth ----
pages.auth = async (root) => {
  const a = await api('/api/auth');
  root.innerHTML =
    '<div class="card"><h2>Active auth</h2><span class="pill green"><span class="dot"></span>' + esc(a.method) + '</span>' +
    '<div class="muted" style="margin-top:8px">Auth flows through the Claude Code credential chain only — the console never stores or displays tokens (INV-12).</div></div>' +
    (a.warnings.length
      ? a.warnings.map((w) => '<div class="banner ' + (w.severity === 'red' ? 'red' : 'yellow') + '"><b>' + esc(w.variable) + '</b> ' + esc(w.message) + '</div>').join('')
      : '<div class="banner green">No env variables shadow the subscription login.</div>') +
    '<div class="card"><h2>Setup token guidance</h2><div class="muted">Run <code>claude setup-token</code> in a terminal for long-lived headless auth. This console intentionally has no field to paste tokens into.</div></div>';
};

// ---- F-Mem ----
pages.memory = async (root) => {
  root.innerHTML =
    '<div class="card"><h2>CLAUDE.md editor</h2>' +
    '<div class="row"><label>Scope</label><select id="scope" aria-label="scope"><option>user</option><option>project</option></select>' +
    '<button class="primary" id="save">Save</button></div>' +
    '<textarea id="body" aria-label="editor content" style="min-height:280px" spellcheck="false"></textarea>' +
    '<div class="muted">Memory is guidance for the model, not enforcement — hard rules belong in Permissions. Applies to new sessions.</div></div>';
  let expectedHash;
  const load = async () => {
    try {
      const r = await api('/api/memory/' + $('#scope').value + dirQ());
      $('#body').value = r.content ?? ''; expectedHash = r.hash;
    } catch (e) { fail(e); }
  };
  $('#scope').onchange = load;
  $('#save').onclick = async () => {
    try {
      await api('/api/memory/' + $('#scope').value + dirQ(), { method: 'PUT', body: { content: $('#body').value, expectedHash } });
      savedToast(); await load();
    } catch (e) { fail(e); }
  };
  await load();
};

// ---- F-MCP (3 layers: user / project / managed-ro) ----
pages.mcp = async (root) => {
  const r = await api('/api/mcp' + dirQ());
  const disabled = new Set(r.disabled || []);
  const layer = (title, l) => {
    if (!l) return '';
    const names = Object.keys(l.servers || {});
    return '<div class="card"><h2>' + esc(title) + ' <span class="pill">' + names.length + '</span> <span class="muted">' + esc(l.path) + (l.readOnly ? ' · read-only' : '') + '</span></h2>' +
      (names.length ? '<table><tr><th>Server</th><th>Type</th><th style="text-align:right">Actions</th></tr>' + names.map((n) => {
        const s = l.servers[n] || {};
        const type = s.command ? 'stdio' : (s.url ? 'http' : '?');
        const off = disabled.has(n);
        return '<tr><td><code>' + esc(n) + '</code>' + (off ? ' <span class="pill">disabled</span>' : '') + '</td>' +
          '<td class="muted">' + esc(type) + '</td><td style="text-align:right;white-space:nowrap">' +
          (s.command ? '<button class="ghost" data-test="' + esc(n) + '">test</button>' : '') +
          (l.readOnly ? '' : '<button class="ghost" data-toggle="' + esc(n) + '" data-off="' + (off ? '0' : '1') + '">' + (off ? 'enable' : 'disable') + '</button>') +
          '</td></tr>';
      }).join('') + '</table>' : empty('none')) + '</div>';
  };
  root.innerHTML =
    layer('User (~/.claude.json)', r.user) +
    layer('Project (.mcp.json)', r.project) +
    (r.managed ? layer('Managed (admin, read-only)', r.managed) : '') +
    '<div id="testout"></div>' +
    '<div class="card"><h2>Add server <span class="muted">project .mcp.json</span></h2>' +
    '<div class="row"><input type="text" id="name" aria-label="name" placeholder="name" style="width:180px"></div>' +
    '<textarea id="def" aria-label="server definition JSON" placeholder="{&quot;command&quot;:&quot;npx&quot;,&quot;args&quot;:[&quot;-y&quot;,&quot;some-mcp&quot;]} or {&quot;url&quot;:&quot;https://...&quot;}"></textarea>' +
    '<div class="row"><button class="primary" id="add">Add</button>' +
    '<span class="muted">Test is a stdio start-check (spawns the command 5s) — not a full handshake. Takes effect next session start.</span></div></div>';
  $('#add').onclick = async () => {
    try {
      await api('/api/mcp' + dirQ(), { method: 'PUT', body: { name: $('#name').value, server: JSON.parse($('#def').value) } });
      savedToast('New sessions will see this server.'); route();
    } catch (e) { fail(e); }
  };
  root.onclick = async (ev) => {
    const t = ev.target.closest('[data-test]');
    const tg = ev.target.closest('[data-toggle]');
    if (t) {
      if (!(await confirmDialog('Run start-check?', 'This spawns the "' + t.dataset.test + '" command from .mcp.json on THIS host (start-check, not a full handshake).', { action: 'Run' }))) return;
      try {
        $('#testout').innerHTML = '<div class="banner">testing ' + esc(t.dataset.test) + '… (up to 5s)</div>';
        const res = await api('/api/mcp/test' + dirQ(), { method: 'POST', body: { name: t.dataset.test, consent: true } });
        const cls = res.ok === true ? 'green' : (res.ok === false ? 'red' : 'yellow');
        $('#testout').innerHTML = '<div class="banner ' + cls + '"><b>' + esc(t.dataset.test) + ' · ' + esc(res.check) + '</b> ' + esc(res.note) + '</div>';
      } catch (e) { fail(e); }
      return;
    }
    if (tg) {
      try { await api('/api/mcp/disable', { method: 'POST', body: { name: tg.dataset.toggle, disabled: tg.dataset.off === '1' } });
        savedToast('Applies to new sessions.'); route(); } catch (e) { fail(e); }
    }
  };
};

// ---- F-Hook ----
pages.hooks = async (root) => {
  const r = await api('/api/hooks' + dirQ());
  const scopes = Object.entries(r.scopes).filter(([, v]) => v.hooks && Object.keys(v.hooks).length);
  const disabledScopes = Object.entries(r.scopes).filter(([, v]) => v.disableAllHooks);
  const types = r.handlerTypes || ['command'];
  root.innerHTML =
    '<div class="card"><h2>Configured hooks</h2>' +
    (scopes.length ? scopes.map(([k, v]) =>
      '<div class="row"><span class="pill">' + esc(k) + '</span></div><pre>' + esc(JSON.stringify(v.hooks, null, 2)) + '</pre>').join('')
      : empty('No hooks configured in any scope')) +
    (disabledScopes.length ? '<div class="banner yellow"><b>disableAllHooks</b> is ON in: ' + esc(disabledScopes.map(([k]) => k).join(', ')) + '</div>' : '') +
    '<div class="muted">The TUI /hooks menu is read-only — this page is the editor.</div></div>' +
    '<div class="card"><h2>Add hook</h2>' +
    '<div class="row"><label>Scope</label><select id="scope" aria-label="scope"><option>project</option><option>user</option><option>local</option></select>' +
    '<label>Event</label><select id="event" aria-label="hook event">' + r.events.map((e) => '<option>' + esc(e) + '</option>').join('') + '</select>' +
    '<label>Type</label><select id="htype" aria-label="handler type">' + types.map((t) => '<option>' + esc(t) + '</option>').join('') + '</select></div>' +
    '<div class="row"><input type="text" id="matcher" aria-label="hook matcher" placeholder="matcher (optional, e.g. Bash)" style="width:220px">' +
    '<input type="text" id="cmd" aria-label="hook command" placeholder="command (required for type=command)" style="flex:1;min-width:220px"></div>' +
    '<div class="row"><label style="font-weight:400"><input type="checkbox" id="consent"> I understand this runs on my machine on every matching event</label></div>' +
    '<div class="row"><button class="primary" id="add">Add hook</button><span class="muted">Applies to new sessions.</span></div></div>' +
    '<div class="card"><h2>Master switch <span class="muted">disableAllHooks</span></h2>' +
    '<div class="row"><label>Scope</label><select id="dscope" aria-label="disable scope"><option>project</option><option>user</option><option>local</option></select>' +
    '<label style="font-weight:400"><input type="checkbox" id="dconsent"> I understand this can silence security hooks</label></div>' +
    '<div class="row"><button class="danger" id="disableAll">Disable all hooks</button><button id="enableAll">Re-enable</button>' +
    '<span class="muted">Turns every hook in that scope off/on.</span></div></div>';
  $('#add').onclick = async () => {
    try {
      const body = { event: $('#event').value, type: $('#htype').value, command: $('#cmd').value, consent: $('#consent').checked };
      if ($('#matcher').value) body.matcher = $('#matcher').value;
      await api('/api/hooks/' + $('#scope').value + dirQ(), { method: 'PUT', body });
      savedToast(); route();
    } catch (e) { fail(e); }
  };
  const setDisableAll = async (val) => {
    try {
      await api('/api/hooks/' + $('#dscope').value + '/disable-all' + dirQ(), { method: 'PUT', body: { disableAllHooks: val, consent: $('#dconsent').checked } });
      savedToast(); route();
    } catch (e) { fail(e); }
  };
  $('#disableAll').onclick = () => setDisableAll(true);
  $('#enableAll').onclick = () => setDisableAll(false);
};

// ---- F-Sub ----
pages.subagents = async (root) => {
  const r = await api('/api/subagents' + dirQ());
  root.innerHTML =
    '<div class="card"><h2>Subagents <span class="pill">' + r.subagents.length + '</span> <span class="muted">' + esc(r.dir) + '</span></h2>' +
    (r.subagents.length ? r.subagents.map((s) => {
      const name = s.file.replace(/\\.md$/, '');
      return '<div class="row"><span class="pill">' + esc(s.file) + '</span>' +
        '<button class="ghost" data-test="' + esc(name) + '">test-run (dry)</button>' +
        '<button class="ghost danger" data-del="' + esc(name) + '">delete</button></div><pre>' + esc(s.content) + '</pre>';
    }).join('') : empty('No subagents yet', 'Create one below — it becomes a Markdown file with frontmatter')) +
    '<div id="subout"></div></div>' +
    '<div class="card"><h2>Create subagent</h2>' +
    '<div class="row"><input type="text" id="name" aria-label="name" placeholder="kebab-case-name" style="width:220px">' +
    '<input type="text" id="desc" aria-label="description" placeholder="description" style="flex:1;min-width:220px"></div>' +
    '<textarea id="prompt" aria-label="system prompt" placeholder="system prompt"></textarea>' +
    '<div class="row"><button class="primary" id="add">Create</button></div></div>';
  $('#add').onclick = async () => {
    try {
      await api('/api/subagents' + dirQ(), { method: 'PUT', body: { name: $('#name').value, description: $('#desc').value, prompt: $('#prompt').value } });
      savedToast('Available to new sessions.'); route();
    } catch (e) { fail(e); }
  };
  root.onclick = async (ev) => {
    const t = ev.target.closest('[data-test]');
    const d = ev.target.closest('[data-del]');
    if (t) {
      try {
        const res = await api('/api/subagents/' + t.dataset.test + '/test-run' + dirQ(), { method: 'POST' });
        $('#subout').innerHTML = '<div class="banner ' + (res.wouldLoad ? 'green' : 'yellow') + '"><b>' + esc(t.dataset.test) +
          (res.wouldLoad ? ' would load' : ' issues') + '</b> ' + esc(res.note) + (res.issues.length ? ' — ' + esc(res.issues.join('; ')) : '') + '</div>';
      } catch (e) { fail(e); }
      return;
    }
    if (d) {
      if (!(await confirmDialog('Delete subagent?', d.dataset.del + '.md is removed from disk.', { danger: true, action: 'Delete' }))) return;
      try { await api('/api/subagents/' + d.dataset.del + dirQ(), { method: 'DELETE' }); toast('Deleted', 'green'); route(); } catch (e) { fail(e); }
    }
  };
};

// ---- F-Skill ----
pages.skills = async (root) => {
  const r = await api('/api/skills' + dirQ());
  const list = (xs) => xs.length
    ? xs.map((x) => '<span class="pill" style="margin:2px 4px 2px 0">' + esc(x) + '</span>').join('')
    : empty('none');
  const plugins = r.plugins || {};
  const pnames = Object.keys(plugins);
  root.innerHTML =
    '<div class="grid2">' +
    '<div class="card"><h2>User skills <span class="muted">~/.claude/skills</span></h2>' + list(r.user) + '</div>' +
    '<div class="card"><h2>Project skills <span class="muted">.claude/skills</span></h2>' + list(r.project) + '</div>' +
    '</div>' +
    '<div class="card"><h2>Plugins <span class="muted">enabledPlugins · user settings</span></h2>' +
    (pnames.length ? '<table><tr><th>Plugin</th><th>State</th><th style="text-align:right"></th></tr>' + pnames.map((n) => {
      const on = !!plugins[n];
      return '<tr><td><code>' + esc(n) + '</code></td><td>' +
        (on ? '<span class="pill green"><span class="dot"></span>enabled</span>' : '<span class="pill">disabled</span>') + '</td>' +
        '<td style="text-align:right"><button class="ghost" data-plug="' + esc(n) + '" data-en="' + (on ? '0' : '1') + '">' + (on ? 'disable' : 'enable') + '</button></td></tr>';
    }).join('') + '</table>' : empty('No plugins configured')) +
    '<div class="row" style="margin-top:8px"><input type="text" id="pname" aria-label="plugin name" placeholder="name@marketplace" style="flex:1;max-width:320px">' +
    '<label style="font-weight:400"><input type="checkbox" id="pconsent"> consent (runs third-party code)</label>' +
    '<button class="primary" id="paddon">Enable plugin</button></div>' +
    '<div class="muted">Enabling a plugin runs third-party code — consent required. The marketplace lives in the CLI.</div></div>';
  root.onclick = async (ev) => {
    const b = ev.target.closest('[data-plug]'); if (!b) return;
    const enable = b.dataset.en === '1';
    if (enable && !(await confirmDialog('Enable plugin?', b.dataset.plug + ' will run third-party code in your sessions.', { action: 'Enable' }))) return;
    try {
      await api('/api/skills/plugins', { method: 'PUT', body: enable ? { name: b.dataset.plug, enabled: true, consent: true } : { name: b.dataset.plug, enabled: false } });
      savedToast('Applies to new sessions.'); route();
    } catch (e) { fail(e); }
  };
  $('#paddon').onclick = async () => {
    try {
      await api('/api/skills/plugins', { method: 'PUT', body: { name: $('#pname').value, enabled: true, consent: $('#pconsent').checked } });
      savedToast('Applies to new sessions.'); route();
    } catch (e) { fail(e); }
  };
};

// ---- F-Usage ----
pages.usage = async (root) => {
  root.innerHTML = '<div class="card">' + skeleton(5) + '</div>';
  const u = await api('/api/usage');
  const alerts = await api('/api/usage/alerts');
  const full = await api('/api/usage/full').catch(() => null);
  const bar = (n, max) => '<div style="height:6px;border-radius:4px;background:var(--accent-soft);margin-top:3px">' +
    '<div style="height:6px;border-radius:4px;background:var(--accent);width:' + Math.max(2, Math.round(n / max * 100)) + '%"></div></div>';
  const tab = (rows, k) => {
    if (!rows.length) return '<div class="empty"><span class="big">◌</span>No data yet' +
      '<div class="muted" style="margin-top:4px"><a href="#/sessions">Rebuild the search index on the Sessions page →</a></div></div>';
    const max = Math.max(...rows.map((r) => r.sessions));
    return '<table>' + rows.map((r) => '<tr><td style="width:55%">' + esc(r[k]) + bar(r.sessions, max) + '</td>' +
      '<td style="text-align:right;font-weight:600">' + r.sessions + '</td></tr>').join('') + '</table>';
  };
  const reset = u.resetEstimate || {};
  const cal = u.calibration || {};
  const fmtReset = (t) => t ? new Date(t).toLocaleString() : '—';
  root.innerHTML =
    '<div class="grid2">' +
    '<div class="card"><h2>5h window</h2><div class="kpi">' + u.currentWindow.sessions + '<small>sessions</small></div>' +
    '<div class="muted" style="margin-top:6px">resets ~' + esc(fmtReset(reset.windowResetAt)) + '</div></div>' +
    '<div class="card"><h2>Week</h2><div class="kpi">' + u.week.sessions + '<small>sessions</small></div>' +
    '<div class="muted" style="margin-top:6px">weekly reset ~' + esc(fmtReset(reset.weeklyResetAt)) + (cal.actualPct != null ? ' · calibrated ' + esc(cal.actualPct) + '%' : '') + '</div></div>' +
    '</div>' +
    '<div class="muted" style="margin:-6px 0 12px">' + esc(u.label) + ' · ' + esc(u.officialSource) + '</div>' +
    alerts.alerts.map((a) => '<div class="banner ' + (a.level === 'warn' ? 'yellow' : 'green') + '">' + esc(a.message) + '</div>').join('') +
    '<div class="card"><h2>Calibration <span class="muted">anchor the estimate with real numbers from /usage</span></h2>' +
    '<div class="row"><label>actual %</label><input type="number" id="calPct" min="0" max="100" value="' + esc(cal.actualPct != null ? cal.actualPct : '') + '" placeholder="from /usage" style="width:110px">' +
    '<label>weekly reset day</label><input type="number" id="calDay" min="0" max="6" value="' + esc(cal.weeklyResetDay != null ? cal.weeklyResetDay : '') + '" placeholder="0=Sun" style="width:90px">' +
    '<label>hour</label><input type="number" id="calHour" min="0" max="23" value="' + esc(cal.weeklyResetHour != null ? cal.weeklyResetHour : '') + '" placeholder="0-23" style="width:80px">' +
    '<button class="primary" id="calSave">Save calibration</button></div>' +
    '<div class="muted">No official quota API exists — these anchor the local estimate (§5.3).</div></div>' +
    (full
      ? '<div class="grid2">' +
        '<div class="card"><h2>By day</h2>' + tab(full.byDay, 'day') + '</div>' +
        '<div class="card"><h2>By project</h2>' + tab(full.byProject.map((x) => ({ ...x, projectKey: x.projectKey.split('-').slice(-2).join('/') })), 'projectKey') + '</div>' +
        '<div class="card"><h2>By model</h2>' + tab(full.byModel, 'model') + '</div>' +
        '</div><div class="muted">' + esc(full.label) + '</div>'
      : '');
  const numOrNull = (id) => { const v = $('#' + id).value; return v === '' ? null : Number(v); };
  $('#calSave').onclick = async () => {
    try {
      await api('/api/usage/calibration', { method: 'PUT', body: { actualPct: numOrNull('calPct'), weeklyResetDay: numOrNull('calDay'), weeklyResetHour: numOrNull('calHour') } });
      savedToast('Calibration saved.'); route();
    } catch (e) { fail(e); }
  };
};

// ---- F-Act ----
pages.activity = async (root) => {
  root.innerHTML =
    '<div class="card"><h2>Feed hooks</h2>' +
    '<div class="row"><label style="font-weight:400"><input type="checkbox" id="consent"> I consent to installing hooks into settings.json</label></div>' +
    '<div class="row"><button class="primary" id="install">Install feed hooks</button><button id="uninstall">Uninstall</button></div>' +
    '<div class="muted">Hooks are fail-open with a 2s timeout — a stopped console never blocks the CLI.</div></div>' +
    '<div class="card"><h2>Live events <span class="pill green"><span class="dot"></span>streaming</span></h2>' +
    '<table id="feed"><tr><th style="width:50px">#</th><th style="width:90px">Time</th><th>Event</th></tr></table></div>';
  const row = (e) => {
    const b = e.body || {};
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="muted">' + e.seq + '</td><td class="muted">' + new Date(e.ts).toLocaleTimeString() + '</td>' +
      '<td>' + esc(b.hook_event_name || JSON.stringify(b).slice(0, 120)) + (b.tool_name ? ' · <b>' + esc(b.tool_name) + '</b>' : '') + '</td>';
    const t = $('#feed');
    t.insertBefore(tr, t.rows[1] || null);
    while (t.rows.length > 60) t.deleteRow(-1);
  };
  try { (await api('/api/events/recent')).events.slice(-30).forEach(row); } catch (e) { fail(e); }
  const es = new EventSource('/api/events/feed');
  es.onmessage = (m) => row(JSON.parse(m.data));
  onLeave(() => es.close());
  $('#install').onclick = async () => {
    try {
      await api('/api/activity/hooks/install', { method: 'POST', body: { scope: 'project', dir: getProject() || undefined, consent: $('#consent').checked } });
      savedToast('Feed hooks active for new sessions.');
    } catch (e) { fail(e); }
  };
  $('#uninstall').onclick = async () => {
    if (!(await confirmDialog('Uninstall feed hooks?', 'Removes the console-installed hook entries from settings.json.', { action: 'Uninstall' }))) return;
    try { const r = await api('/api/activity/hooks/uninstall', { method: 'POST', body: { scope: 'project', dir: getProject() || undefined } });
      toast('Removed ' + r.removed + ' hook entries', 'green'); } catch (e) { fail(e); }
  };
};

// ---- F-Loop ----
pages.loop = async (root) => {
  root.innerHTML =
    '<div class="card"><h2>Approval queue</h2><div id="apr">' + skeleton(3) + '</div></div>' +
    '<div class="card"><h2>Escalations <span class="muted">decidable — pick a priced option</span></h2><div id="esc">…</div></div>' +
    '<div class="card"><h2>Tasks (state machine)</h2><div id="tasks">…</div></div>' +
    '<div class="card"><h2>Steer a running task</h2>' +
    '<div class="row"><input type="text" id="taskId" aria-label="task id" placeholder="task id" style="width:200px"></div>' +
    '<textarea id="guidance" aria-label="guidance text" placeholder="guidance for the task (injected as marked data, never executed)"></textarea>' +
    '<div class="row"><button class="primary" id="steer">Steer</button></div></div>' +
    '<div class="card"><h2>Recent loop events</h2><pre id="events">…</pre></div>' +
    '<div class="card"><h2>Latest calibration</h2><pre id="cal">…</pre></div>' +
    '<div class="banner red" style="align-items:center"><b>Kill switch</b>' +
    '<span class="muted" style="flex:1">stops the autonomous loop immediately; the event log is preserved</span>' +
    '<button class="danger" id="kill">KILL loop</button></div>';
  const refresh = async () => {
    try {
      const { approvals } = await api('/api/loop/approvals');
      $('#apr').innerHTML = approvals.length ? approvals.map((p) =>
        '<div class="card"><div class="row"><b>' + esc(p.taskId) + '</b>' +
        '<span class="pill yellow"><span class="dot"></span>risk ' + esc(p.risk ?? '?') + '</span>' +
        '<span class="pill">' + esc(p.kind ?? 'approval') + '</span></div>' +
        '<pre>' + esc(JSON.stringify(p, null, 2).slice(0, 1600)) + '</pre>' +
        '<div class="row"><button class="primary" data-v="approved" data-id="' + esc(p.id) + '">Approve</button>' +
        '<button class="danger" data-v="rejected" data-id="' + esc(p.id) + '">Reject</button></div></div>').join('')
        : empty('No pending approvals');
      const ev = await api('/api/loop/events?since=0');
      const events = ev.events ?? [];
      // derive per-task latest state from the event stream (task graph + state machine view)
      const latest = {};
      for (const e of events) { if (e.taskId && e.taskId !== '*') latest[e.taskId] = e; }
      const taskRows = Object.keys(latest).sort();
      $('#tasks').innerHTML = taskRows.length
        ? '<table><tr><th>Task</th><th>State (latest event)</th><th>#</th><th style="text-align:right">Control</th></tr>' + taskRows.map((tid) =>
            '<tr><td><code>' + esc(tid) + '</code></td><td>' + esc(latest[tid].type) + '</td><td class="muted">' + esc(latest[tid].seq) + '</td>' +
            '<td style="text-align:right;white-space:nowrap"><button class="ghost" data-pause="' + esc(tid) + '">pause</button>' +
            '<button class="ghost" data-resume="' + esc(tid) + '">resume</button></td></tr>').join('') + '</table>' +
          '<div class="muted">Pause finishes the current atomic action then holds — resume continues. Distinct from the irreversible Kill switch below.</div>'
        : empty('No task activity yet');
      $('#events').textContent = events.slice(-30).map((e) => e.seq + ' ' + e.type + ' ' + e.taskId).join('\\n') || '(empty)';
    } catch (e) {
      if (IGNORED.has(String(e.message)) || !root.isConnected) return;
      $('#apr').innerHTML = empty('Loop not running', 'Human Plane API not reachable — start a loop from the Scheduler or scripts/run-*.mjs');
      $('#tasks').innerHTML = empty('Loop not running');
      $('#events').textContent = '(loop not running)';
    }
    try {
      const { escalations } = await api('/api/loop/escalations');
      $('#esc').innerHTML = (escalations && escalations.length) ? escalations.map((x) =>
        '<div class="card"><div class="row"><b>' + esc(x.taskId || '') + '</b><span class="pill">' + esc(x.reason || 'escalation') + '</span></div>' +
        '<p>' + esc(x.question || '') + '</p><div class="row">' +
        (x.options || []).map((o) =>
          '<button class="primary" data-esc="' + esc(x.id) + '" data-opt="' + esc(o.label) + '">' + esc(o.label) +
          ((o.estimatedCost != null || o.risk != null) ? ' <span class="muted">(' + esc(o.estimatedCost != null ? o.estimatedCost : '') + (o.risk != null ? ' · risk ' + esc(o.risk) : '') + ')</span>' : '') +
          '</button>').join('') + '</div></div>').join('')
        : empty('No escalations');
    } catch (e) { if (!IGNORED.has(String(e.message))) $('#esc').innerHTML = empty('Loop not running'); }
    try {
      const c = await api('/api/loop/calibration');
      $('#cal').textContent = c.calibration ? (c.file ? c.file + '\\n' : '') + JSON.stringify(c.calibration, null, 2) : (c.note || 'none');
    } catch (e) { if (!IGNORED.has(String(e.message))) $('#cal').textContent = '(unavailable)'; }
  };
  $('#apr').onclick = async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    try { await api('/api/loop/approvals/' + b.dataset.id, { method: 'POST', body: { verdict: b.dataset.v } }); toast('Decision recorded: ' + b.dataset.v, 'green'); refresh(); }
    catch (e) { fail(e); }
  };
  $('#esc').onclick = async (ev) => {
    const b = ev.target.closest('[data-esc]'); if (!b) return;
    try { await api('/api/loop/escalations/' + b.dataset.esc, { method: 'POST', body: { optionLabel: b.dataset.opt } });
      toast('Escalation resolved: ' + b.dataset.opt, 'green'); refresh(); } catch (e) { fail(e); }
  };
  $('#tasks').onclick = async (ev) => {
    const p = ev.target.closest('[data-pause]');
    const r = ev.target.closest('[data-resume]');
    if (p) { try { await api('/api/loop/pause', { method: 'POST', body: { taskId: p.dataset.pause } }); toast('Paused ' + p.dataset.pause + ' — resume when ready', 'green'); refresh(); } catch (e) { fail(e); } return; }
    if (r) { try { await api('/api/loop/resume', { method: 'POST', body: { taskId: r.dataset.resume } }); toast('Resumed ' + r.dataset.resume, 'green'); refresh(); } catch (e) { fail(e); } }
  };
  $('#steer').onclick = async () => {
    try { await api('/api/loop/steer', { method: 'POST', body: { taskId: $('#taskId').value, guidance: $('#guidance').value } });
      toast('Guidance injected as marked data', 'green'); } catch (e) { fail(e); }
  };
  $('#kill').onclick = async () => {
    if (!(await confirmDialog('Kill the autonomous loop?', 'All running loop work stops now. The event log is preserved.', { danger: true, action: 'KILL' }))) return;
    try { await api('/api/loop/kill', { method: 'POST', body: {} }); toast('Kill signal sent', 'green'); } catch (e) { fail(e); }
  };
  await refresh();
  every(() => { if (!root.contains(document.activeElement)) refresh(); }, 8000);
};

// ---- F-Sched ----
pages.sched = async (root) => {
  const { jobs } = await api('/api/sched');
  const guard = await api('/api/guards/automation');
  root.innerHTML =
    '<div class="banner ' + (guard.allowed ? 'green' : 'yellow') + '"><b>Automation guard</b> utilization ' +
    Math.round(guard.utilization * 100) + '% / threshold ' + Math.round(guard.threshold * 100) + '% — ' +
    (guard.allowed ? 'automation allowed' : 'over threshold: new jobs defer until reset (interactive keeps priority)') + '</div>' +
    '<div class="card"><h2>Jobs <span class="pill">' + jobs.length + '</span></h2>' +
    (jobs.length ? '<table>' + jobs.map((j) => '<tr><td>' + esc(j) + '</td><td style="text-align:right"><button class="ghost danger" data-j="' + esc(j) + '">stop</button></td></tr>').join('') + '</table>'
      : empty('No jobs running')) + '</div>' +
    '<div class="card"><h2>Start opaque job</h2>' +
    '<div class="row"><input type="text" id="jname" aria-label="job name" placeholder="name" style="width:160px">' +
    '<input type="text" id="jcmd" aria-label="job command" placeholder="command e.g. ./scripts/calibrate.sh" style="flex:1;min-width:240px"><button class="primary" id="jstart">Start</button></div>' +
    '<div class="muted">Start/stop only — task scheduling and leases belong to the core, not the console.</div></div>';
  $('#jstart').onclick = async () => {
    const name = $('#jname').value, cmd = $('#jcmd').value;
    // scheduler enable confirmation (§13.3): automation consumes the shared Max quota
    if (!(await confirmDialog('Start automation job?', name + ' runs "' + cmd + '" unattended and consumes the shared subscription quota (guarded at the threshold above).', { action: 'Start' }))) return;
    try { await api('/api/sched/start', { method: 'POST', body: { name, cmd } }); toast('Started', 'green'); route(); }
    catch (e) { fail(e); }
  };
  root.onclick = async (ev) => {
    const b = ev.target.closest('button[data-j]'); if (!b) return;
    if (!(await confirmDialog('Stop job?', b.dataset.j + ' receives SIGTERM immediately.', { danger: true, action: 'Stop' }))) return;
    try { await api('/api/sched/stop', { method: 'POST', body: { name: b.dataset.j } }); route(); } catch (e) { fail(e); }
  };
};

// ---- F-Sys ----
pages.system = async (root) => {
  root.innerHTML = '<div class="card">' + skeleton(4) + '</div>';
  const s = await api('/api/system');
  const gb = (n) => (n / 1073741824).toFixed(1) + ' GB';
  root.innerHTML =
    '<div class="grid2">' +
    '<div class="card"><h2>Host</h2><table>' +
    '<tr><td class="muted">loadavg</td><td>' + s.host.loadavg.map((x) => x.toFixed(2)).join(' / ') + '</td></tr>' +
    '<tr><td class="muted">memory</td><td>' + gb(s.host.freemem) + ' free of ' + gb(s.host.totalmem) + '</td></tr></table></div>' +
    '<div class="card"><h2>Retention</h2>' +
    '<div class="row"><label>cleanupPeriodDays</label>' +
    '<input type="number" id="days" aria-label="cleanup period days" value="' + esc(Number(s.retention.cleanupPeriodDays) || '') + '" placeholder="unset" min="1" max="3650" style="width:110px">' +
    '<button class="primary" id="saveRet">Save</button></div>' +
    '<div class="muted">' + esc(s.retention.warning) + '</div></div>' +
    '</div>' +
    '<div class="card"><h2>Update</h2><div class="muted">' + esc(s.updateHint || 'unknown') + '</div>' +
    '<div class="muted" style="margin-top:4px">Run <code>claude update</code> in a terminal to apply.</div></div>' +
    '<div class="card"><h2>Doctor</h2><pre>' + esc(typeof s.doctor === 'string' ? s.doctor : JSON.stringify(s.doctor, null, 2)) + '</pre></div>';
  $('#saveRet').onclick = async () => {
    const v = $('#days').value;
    if (!(await confirmDialog('Change retention?', 'Set transcript retention to ' + (v || 'unset') + ' days. Lowering it deletes old transcripts.', { danger: true, action: 'Change' }))) return;
    try { const r = await api('/api/system/retention', { method: 'PUT', body: { cleanupPeriodDays: v ? Number(v) : null } });
      savedToast(r.warning); } catch (e) { fail(e); }
  };
};

// ---- router ----
let firstRoute = true;
async function route() {
  gen++; // invalidate in-flight continuations from the previous page
  for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* noop */ } }
  const page = (location.hash.replace(/^#\\//, '') || 'status').split('?')[0];
  document.querySelectorAll('#nav a.item').forEach((a) => a.classList.toggle('on', a.dataset.p === page));
  const title = TITLES[page] || 'Console';
  $('#pageTitle').textContent = title;
  document.title = title + ' — Platform Console';
  if (!firstRoute) $('#pageTitle').focus({ preventScroll: true }); // announce page change to AT
  firstRoute = false;
  $('#content').innerHTML = '<div id="page"></div>';
  const pageEl = $('#page');
  fillProjectBar();
  try { await (pages[page] || pages.status)(pageEl); }
  catch (e) {
    if (!IGNORED.has(String(e.message)) && pageEl.isConnected) {
      pageEl.innerHTML = '<div class="banner red">' + esc(e.message) + '</div>';
    }
  }
}
window.addEventListener('hashchange', route);
route();
</script>
</body>
</html>`;
