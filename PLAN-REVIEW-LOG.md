# Plan Review Log: decisions 1-6 + Rich F-Chat + full-SPA responsive
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.

Locked decisions: D-001 OFF, D-002 deferred, D-003 OFF, D-004 single-pool, build Rich F-Chat +
full-SPA responsive, keep i18n/canary cut, PR #1 merge is human-only.

## Round 1 — Codex
Thread: 019f3147-1b2e-77c3-aed2-307a5f19ec94 · VERDICT: REVISE

- ApprovalStore ใช้ผิดบริบท: อยู่ core, Human Plane ผูก loop/token; chat approve ไม่ได้ถ้า loop ไม่รัน, schema เป็น diff review ไม่ใช่ tool permission. Fix: chat permission store/endpoint เฉพาะ หรือขยาย Human Plane รองรับ requestId/toolUseID/toolName/input.
- canUseTool blocking เสี่ยง hang ถาวร (SDK 0.3.200 permission prompts ไม่มี deadline). Fix: pending promise keyed by requestId, default deny on timeout/close/abort.
- Read tools ไม่ปลอดภัยพอ: auto-allow Read/Grep/Glob ยังอ่าน .env, SSH keys, secrets. Fix: cwd allowlist, deny credential paths, redact, read deny rules.
- SDK default settings อาจ widen permission: query() โหลด user/project/local settings, อาจเปิด bypassPermissions/MCP/hooks/plugins. Fix: restrictive settingSources, permissionMode restrictive, tools allowlist, no implicit MCP/plugins.
- Tool classifier ไม่ครบ: SDK มี Task, MCP, WebFetch, WebSearch, NotebookEdit, subagents. Fix: allowlist Read/Grep/Glob only; deny unknown, mcp__*, Task, web, edit/write/bash.
- ApprovalStore ไม่มี await/resolve primitive. Fix: permission broker returning Promise<PermissionResult>.
- WS upgrade reuse เสี่ยง double-listener race (terminal.ts owns on('upgrade')). Fix: central single dispatcher routes /ws/term + /ws/chat.
- WS auth incomplete: Fastify preHandler ไม่ครอบ upgrade; ticket ต้อง carry auth/peer/session binding. Fix: ticket after REST auth, bind principal/session/cwd, single-use, expiry.
- Hardcoded ws:// breaks behind HTTPS. Fix: wss when https.
- "search index for free" false: index manual/background, not live. Fix: index on turn/session end หรือลบ claim.
- Resume/fork wording ผิด: live query ใช้ options.resume + options.forkSession; forkSession() แยก. Fix: design exact SDK shape from sdk.d.ts.
- Concurrent resume corrupts: สอง socket / terminal+chat append session เดียวกัน. Fix: per-session lock หรือ force fork.
- Quota governance ไม่ enforce: usage เป็น estimate, ไม่มี chat concurrency/rate guard. Fix: rate limit + max active + utilization guard ก่อน query().
- Abort lifecycle missing: tab close ต้อง terminate subprocess + pending permissions. Fix: per-socket AbortController, query close, deny pending, audit.
- Streaming redaction gap: WS อาจ leak ก่อน REST redaction. Fix: redact ทุก outbound chunk/tool block ก่อน ws.send.
- Backpressure missing: slow browser → unbounded queue. Fix: bounded queue, heartbeat, close on overflow.
- UI XSS risk: tool-use innerHTML. Fix: text nodes / single sanitizer, never raw HTML.
- Simpler path: PTY มี parity + permission แล้ว → ทำ thin PTY chat ก่อน, เพิ่ม SDK path หลัง sandbox/permission tests ผ่าน.

### Claude's response
Accepted 16/17 findings — all the security/lifecycle/concurrency/streaming/UI points are real; my plan
bounded F-Chat's execution surface far too loosely. Revised PLAN.md §B into an explicit fail-closed
security model: dedicated permission broker (Promise-based, requestId-keyed, default-deny on
timeout/close/abort) instead of reusing core's diff-review ApprovalStore; sandboxed query() config
(tools allowlist Read/Grep/Glob only, disallow Bash/Write/Edit/Notebook/Web/Task/mcp__*, restrictive
settingSources so settings can't widen, always-ask permissionMode); read-path cwd confinement + credential
deny + redact; central single WS upgrade dispatcher; auth-bound single-use chat tickets; wss-when-https
(also flags the same pre-existing bug in terminal.ts); streaming redaction before ws.send; backpressure
bound; text-node/sanitizer rendering; per-session lock; quota enforcement (rate + max-active + utilization)
before spawn; abort lifecycle; verify SDK resume/fork/canUseTool shape against sdk.d.ts before building.

Rejected 1: "thin PTY-backed chat only" — contradicts the user's locked Rich-chat scope (tool-use
rendering needs query()'s structured stream, which a PTY byte-stream cannot provide). Adopted the safety
half: **phase it** — build + test the permission broker/sandbox to prove fail-closed, then wire the chat
UI on top.

Ignored: the @RTK.md/@karpathy.md "not found" note — those are the operator's global ~/.claude/CLAUDE.md
imports, not repo files; irrelevant to this plan.

## Round 2 — Codex (resume)
VERDICT: REVISE. Confirmed the structural fixes landed (ApprovalStore removed, fail-closed broker, SDK
isolation, central dispatcher, quota/concurrency/abort/redaction/backpressure/XSS/indexing addressed).
7 remaining material issues:
- permissionMode 'always-ask' not in 0.3.200 (union default|acceptEdits|bypassPermissions|plan|dontAsk|auto).
- broker key should be the SDK requestId, not synthesized from toolName+input (collision risk).
- read-path guard vague on symlink/glob traversal — canonicalize realpath, enforce after glob expansion.
- Grep/Glob may shell out via Bash (denied) → degrade; accept explicitly or use console FTS5 search.
- disallowedTools mcp__* wildcard assumed — also set mcpServers:{}/settingSources:[]/skills:[].
- "fix ws:// in terminal.ts" contradicts "PTY changes out of scope" — reclassify as transport bugfix.
- tests missing WS dispatcher regression (/ws/term ticket reuse, peer-guard, expired ticket, close 4403).

### Claude's response
Accepted all 7 — SDK-accuracy, path-traversal, and test-coverage refinements, all correct. Revised PLAN.md:
`permissionMode: 'default'` (noted the real union; verify canUseTool fires); broker keyed by SDK requestId;
read-path realpath-canonicalized + enforced after glob expansion + symlink-escape reject (reuse confinePath);
`Read`-only allowlist with Grep/Glob gated on not-shelling-Bash and the console FTS5 (`search.ts`) as the
reliable search; `settingSources:[]`/`mcpServers:{}`/`skills:[]` + verify mcp deny semantics; ws://→wss
reclassified as an in-scope transport bugfix; phasing now runs WS dispatcher regression tests (ticket reuse,
peer-guard, expired ticket, 4403) before wiring /ws/chat. No rejections this round.

## Round 3 — Codex (resume)
VERDICT: REVISE. All 7 Round-2 findings confirmed addressed. 1 new material issue:
- "reuse core's confinePath" is dangerous/infeasible: `orchestrator.ts` confinePath is `private` (can't
  import) and only `resolve()`s the target after realpath-ing the root, so a symlink inside the root that
  points outside is not caught. Fix: new exported `confineExistingRealPath(root, candidate)` that
  realpathSync's BOTH root and target after glob expansion, rejects target not under root, with a real
  symlink-escape test.

### Claude's response
Accepted — VERIFIED against source: orchestrator.ts:357 `private confinePath`, line 359
`const abs = resolve(root, p)` (target not realpath'd), line 360 textual `startsWith`. Codex is exactly
right; the existing helper both can't be imported and misses in-root symlink escape. Revised PLAN.md's
read-path guard to specify a new exported `confineExistingRealPath(root, candidate)` (realpath both root
and target after glob expansion, reject outside root, symlink-escape test), and flagged the pre-existing
orchestrator gap as a separate out-of-scope fix. No rejections.

## Round 4 — Codex (resume)
VERDICT: APPROVED. Prior issue fixed (exported confineExistingRealPath, realpath root+target after glob
expansion, symlink-escape reject, avoids private confinePath). Remaining items called out as implementation
gates already captured in the plan (canUseTool under 'default' proven before UI; mcp__* deny verified;
WS dispatcher regression tests pass before /ws/chat; orchestrator symlink gap correctly separated) — not
plan blockers.

## Resolution: CONVERGED (APPROVED)
Act 1 grill (7 questions) + Act 2 Codex (4 rounds: REVISE, REVISE, REVISE, APPROVED). Plan locked.
Awaiting operator sign-off to implement.
