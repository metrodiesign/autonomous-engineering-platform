# Plan: close decisions 1-6 + build Rich F-Chat and full-SPA responsive
_Locked via grill — by Claude + metrodiesign · revised after Codex Round 1_

## Goal
Resolve the six open decisions from the spec-conformance sweep and, where the user chose to build rather
than accept a cut, deliver the two features they selected. The four AFK defaults are confirmed as-is; two
intentionally-cut Phase-4 items (F-Chat, responsive) are now in scope as **Rich** F-Chat and **full-SPA**
responsive. i18n, canary, remote-console, and OIDC stay deferred. No production code is written until the
user signs off after Codex review.

## Approach

### A. Confirm defaults (documentation only, no code)
1. D-001 Remote Console = **OFF** (bind 127.0.0.1, gate off).
2. D-002 Identity provider = **Basic-first, OIDC deferred** — resolved by dependency (moot while remote OFF).
3. D-003 Usage credits = **treated OFF** (alert stays "will block at cap").
4. D-004 Quota = **single pool + label every run**; re-check before Fusion (§7.5).
   → Append to `docs/DECISIONS.md`: "D-001..D-004 confirmed by operator 2026-07-05" (append, don't rewrite).

### B. Rich F-Chat (new interactive-lite surface, §16 non-parity)

**Engine.** Each chat session runs the Agent SDK `query()` server-side. Verify the exact 0.3.200 API
(`query`, `options.resume`, `options.forkSession`, `canUseTool`, `settingSources`, `permissionMode`,
`disallowedTools`) against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` **before building**.
PTY parity stays in /terminal; chat is the structured (tool_use/tool_result) surface a PTY byte-stream
cannot provide — this is why Thin/PTY-only was rejected.

**Security model — fail-closed, the core of this feature:**
- **Sandboxed query() config:** explicit `tools` allowlist = `Read` only (add `Grep`/`Glob` only if
  verified they don't shell out via the denied `Bash`; otherwise use the console's FTS5 search instead);
  `disallowedTools` denies the rest — `Bash, Write, Edit, NotebookEdit, WebFetch, WebSearch, Task` + MCP;
  `settingSources: []`, `mcpServers: {}`, `skills: []` so user/project/local `.claude/settings.json`, MCP,
  and skills cannot widen permissions (verify `mcp__*` deny semantics, don't assume the wildcard);
  `permissionMode: 'default'` — the 0.3.200 union is `default|acceptEdits|bypassPermissions|plan|dontAsk|auto`
  (there is no 'always-ask'); confirm `canUseTool` still fires under `'default'`.
- **Permission broker (new — replaces reuse of core's ApprovalStore, which is a diff-review store bound to
  the loop/token):** the `canUseTool` callback calls a broker returning `Promise<PermissionResult>`, keyed
  by the **SDK-provided `requestId`** (store toolName/input as metadata — do NOT synthesize the key from
  toolName+input: collision/duplicate risk, and the SDK expects its own `requestId` echoed). A UI decision
  resolves it; **timeout / socket close / abort → deny**. Any tool not in the allowlist → **default DENY**.
- **Read-path exfiltration guard:** confine allowed reads to the session `cwd` allowlist via a **new
  exported** `confineExistingRealPath(root, candidate)` — `realpathSync` BOTH the root and the (existing)
  target **after glob expansion**, reject anything not under the real root. Do NOT reuse core's
  `confinePath`: it is `private` and only `resolve()`s the target (orchestrator.ts:359), so a symlink inside
  the root pointing outside slips through — a pre-existing gap in orchestrator snapshot/revert, flagged
  here but fixed separately (out of scope). Also reject `../` traversal + case/normalization tricks; deny
  credential paths (`.env*`, `**/.ssh/**`, key/credential files); redact output before it leaves the process.
- **No web-dialog execution approval (INV-17):** the broker never lets the web approve Bash/Write/Edit —
  those are denied outright in chat. Execution stays CLI-native in /terminal or the autonomous loop.

**Transport & auth:**
- Refactor the WS upgrade into a **single central dispatcher** (today `terminal.ts` owns
  `app.server.on('upgrade')`) that routes `/ws/term` and `/ws/chat` — no second `on('upgrade')` listener.
- Chat WS ticket issued only **after** REST auth; binds principal + sessionId + cwd; single-use; expiry-swept.
- Client selects `wss:`/`ws:` from `location.protocol`. Fixing the same hardcoded `ws://` in terminal.ts is
  a **required transport/security bugfix** inside the dispatcher refactor — not a PTY-behavior change.

**Lifecycle & concurrency:**
- Per-socket `AbortController`: tab close → abort query(), terminate its subprocess, deny pending
  permissions, audit the close reason.
- Per-session active lock: a second attach (chat OR terminal) on a live session is rejected or forced to
  fork — no concurrent append to one transcript.
- Quota enforcement **before** spawning query(): chat rate-limit + max concurrent chat sessions +
  utilization guard (chat must not starve interactive/scheduled work); labeled interactive, counted in the
  single pool (D-004/INV-13).

**Streaming & UI:**
- Redact every outbound chunk and tool block **before** `ws.send` (streaming bypasses REST redaction, INV-14).
- Bounded send queue + heartbeat; close on overflow (backpressure).
- Render assistant text and tool_use/tool_result as **text nodes / one sanitizer wrapper** — never raw
  `innerHTML`.

**Rich features:** session list + switch (`listSessions`), resume/fork a prior session (exact SDK shape
per sdk.d.ts), tool-use rendering, streamed tokens. Chat transcripts persist as claude sessions; index
them into search **on turn/session end** (the indexer is manual/background — not "for free").

**Phasing (adopted from Codex's safety gate):**
1. Build the permission broker + sandboxed query() config + path guard, with tests proving fail-closed:
   unknown tool denied, timeout/abort denied, credential path + symlink escape denied, settings cannot widen.
2. WS dispatcher regression tests FIRST (fake PTY + WS client): `/ws/term` single-use ticket (reuse
   rejected), peer-guard, expired ticket, close code `4403` — all must stay exact through the refactor.
3. Only after 1-2 pass: wire the dispatcher's `/ws/chat`, chat routes, and the SPA `#/chat` page.

**Files:** new `console/backend/src/chat.ts` (routes + broker + WS); extract the upgrade dispatcher from
`terminal.ts` into a shared module; new SPA page in `web.ts` nav + `route()`.

### C. Full-SPA responsive
5. Audit the existing `@media (max-width:900px)` block (sidebar→drawer + card scroll already present)
   against all 17 pages + modals + the new chat page.
6. Add a narrow breakpoint (~560px): full-width controls, topbar wraps, reduced padding, modal max-height +
   internal scroll, confirm `table`/`.card` horizontal-scroll holds.
7. Make F-Chat responsive: chat log + composer stack; session list collapses to a drawer/top selector.
8. Verify every page down to ~375px with no horizontal body scroll (real-browser DOM/CSS check).

### D. Close-out (user actions, not agent)
9. Push `build/platform` (updates PR #1) — user decision at sign-off.
10. User reviews + merges PR #1 → main. Agent cannot merge (rule: no merge without human review).

## Key decisions & tradeoffs
- **Rich over Thin F-Chat** (user override): more surface, overlaps F-Sessions. Chat = live composer,
  F-Sessions = manager; reuse the session ops, link rather than duplicate.
- **query() as the chat engine:** a third execution path beside PTY and adapters. Permitted by §16
  (non-parity), but the entire security model above exists to keep it from becoming a web code-exec hole.
- **Reuse terminal WS infra** via a central dispatcher (not a second listener): bidirectional, and the
  ticket/peer-guard security is already built — but the dispatcher refactor must preserve /ws/term exactly.
- **Approval-routed, execution-denied tools:** chat can read (guarded) and reason; it cannot Bash/Write.
  Slower and narrower than a full agent — deliberately, for safety.
- **Full responsive despite remote OFF:** localhost-desktop is the only real client today, so the payoff is
  mostly future-proofing (user accepted this explicitly).

## Risks / open questions
- **R1 (security, highest):** the broker must fail-closed on every unclassified tool/path; one default-allow
  reintroduces web code execution. Prove it with tests before wiring UI.
- **R2:** SDK 0.3.200 `query()` API must be verified against `sdk.d.ts` first — permissionMode enum,
  `canUseTool` requestId shape, `disallowedTools`/`mcp__*` semantics, resume/forkSession — the engine rests
  on these.
- **R3:** the central WS dispatcher must preserve /ws/term ticket, peer-guard, and close-code behavior.
- **R4:** every permission/abort promise must resolve on all exit paths (default deny) — no hang, no leak.
- **R5:** F-Chat/F-Sessions overlap risks two "open session" paths — link them.
- **R6:** concurrent query() vs quota needs an enforced cap + labeling, not an estimate.

## Out of scope
- i18n, canary deploy (no prod target), Thin-only chat, PTY session behavior (spawn/attach/reap) changes.
  (The `ws://`→`wss:` transport fix IS in scope — see §B.)
- D-001 remote enable, D-002 OIDC, D-008 second-machine test — deferred by the confirmed defaults.
- Merging PR #1 (human-only).
