// Phase 0 web surface: single static page over the REST API.
// ponytail: React SPA arrives with F-Term (Phase 1); DoD here only needs projects/sessions/quota/auth-warning visible.
export const INDEX_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Platform Console</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 2rem; max-width: 960px; }
  .card { border: 1px solid #ccc3; border-radius: 8px; padding: 1rem; margin: 0 0 1rem; }
  .red { background: #fee; border-color: #c00; color: #900; }
  .yellow { background: #ffc; border-color: #a80; }
  .muted { opacity: .65; font-size: 12px; }
  h1 { font-size: 18px; } h2 { font-size: 15px; margin: 0 0 .5rem; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 2px 8px 2px 0; border-bottom: 1px solid #ccc3; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #ddd; } }
</style>
</head>
<body>
<h1>Platform Console <span class="muted">Phase 0</span></h1>
<p class="muted" id="disclaimer"></p>
<div id="auth"></div>
<div class="card"><h2>Status</h2><div id="status">loading…</div></div>
<div class="card"><h2>Usage (estimate)</h2><div id="usage">loading…</div></div>
<div class="card"><h2>Projects</h2><div id="projects">loading…</div></div>
<div class="card"><h2>Recent sessions</h2><div id="sessions">loading…</div></div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function j(url) { const r = await fetch(url); return r.json(); }
(async () => {
  const st = await j('/api/status');
  $('disclaimer').textContent = st.disclaimer;
  $('status').innerHTML = 'CLI: ' + esc(st.cli) + '<br>auth: ' + esc(st.auth.method);
  $('auth').innerHTML = st.auth.warnings.map(w =>
    '<div class="card ' + esc(w.severity) + '"><b>' + esc(w.variable) + '</b> — ' + esc(w.message) + '</div>').join('');
  const u = await j('/api/usage');
  $('usage').innerHTML = 'window 5h: ' + u.currentWindow.sessions + ' sessions · week: ' + u.week.sessions +
    ' sessions<br><span class="muted">' + esc(u.label) + ' · ' + esc(u.officialSource) + '</span>';
  const p = await j('/api/projects');
  $('projects').innerHTML = '<table>' + p.projects.slice(0, 20).map(x => '<tr><td>' + esc(x.path) + '</td></tr>').join('') + '</table>';
  const s = await j('/api/sessions?limit=15');
  $('sessions').innerHTML = '<table>' + s.sessions.map(x =>
    '<tr><td>' + esc((x.summary || x.firstPrompt || x.sessionId).slice(0, 80)) + '</td><td class="muted">' +
    new Date(x.lastModified).toLocaleString() + '</td></tr>').join('') + '</table>';
})();
</script>
</body>
</html>`;
