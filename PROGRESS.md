# PROGRESS

> ไฟล์ควบคุมตาม build-kickoff-prompt.md ข้อ 4 — อัปเดตทุก checkpoint

## สถานะปัจจุบัน

- **Phase:** Phase 1 เสร็จ — DoD ผ่านครบ · กำลังเริ่ม Phase 2
- **ทำล่าสุด (Phase 1):** conformance P1-P8 = 8/8 กับ adapter จริง · F-Term พิสูจน์สดบน browser
  (spawn/slash/detach/reattach + audit JSONL) · governance pages (F-Set/F-Perm/F-Mem + Effective
  View + protect-golden installer) · Human Plane API + approval packages · context builder 6 ขั้น ·
  supervised loop 3/3 (held-out golden ผ่าน, model=haiku, .ai/calibration/bootstrap-haiku-2026-07-04.json)
- **ถัดไป:** Phase 2 — breaker + quota-aware routing (§5.4/§10.2) · hypothesis repair (§9.3) ·
  auto-merge L0-L1 + sampling audit · meta-governance + steering · security plane เต็ม (canary,
  dep-policy, data-govern) · Console: F-MCP F-Hook F-Sub F-Skill F-Sys + automation guards

## Build Plan (kickoff ข้อ 6.2)

### (ก) ภารกิจ + invariants หลัก

สร้างแพลตฟอร์ม self-hosted สองโหมดบน substrate เดียว (Claude Code + Max 20x):
Interactive = real `claude` binary ผ่าน PTY (100% CLI parity, INV-17) · Autonomous = propose/dispose
(โมเดลเสนอ, core รัน/วัด — INV-1/2/9) · `core/` ปลอด vendor name (INV-7) · egress default-deny +
secret scan block (INV-14) · fail-closed Console (INV-15) · governance ห้ามลด gate อัตโนมัติ (INV-16) ·
auth ผ่าน credential chain เท่านั้น (INV-12) · state = append-only event log (INV-10)

### (ข) Repo structure ที่จะสร้าง (§14)

```
core/ aal/ adapters/ console/ .ai/ scripts/ src/ test/{ai-generated,golden}/
```
pnpm workspace monorepo · CI: lint + typecheck + build + vendor-name check บน `core/` · pin SDK version

### (ค) Spikes §15 ที่จะรัน (ก่อน Phase 0)

| # | Spike | Hard gate |
|---|-------|-----------|
| 1 | listSessions + getSessionMessages กับข้อมูลจริง | - |
| 2 | PTY parity: node-pty spawn `claude` จริง + xterm.js + slash cmd + resume + detach/attach | **ใช่** |
| 3 | query() streaming 1 turn + canUseTool | - |
| 4 | Subscription billing: unset env auth → รันด้วย /login cred → โควตาขยับ ไม่มีบิล API | **ใช่** |
| 5 | Adapter isolation: allowedTools:[] + settingSources:[] → คืนข้อเสนอ ไม่ execute, config ไม่รั่ว | **ใช่** |

Spikes อยู่ใน `spikes/` (standalone package — ไม่ปนกับ workspace หลัก)

### (ง) Human-decision 4 ข้อ

ผู้ใช้สั่งโหมด AFK (2026-07-04): ไม่ถาม — เลือก default เล็ก+ย้อนกลับได้ บันทึกครบใน
docs/DECISIONS.md (D-001..D-004) ผู้ใช้ทบทวน/พลิกได้ทุกข้อ

## Phase checklist

- [x] §15 spikes 5 ตัว (hard gate: 2, 4, 5) — PASS 5/5, 2026-07-04, spikes/RESULTS.md
- [x] Repo structure §14 + CI + pin SDK — pnpm workspace, INV-7 check, CI เขียว
- [x] Phase 0 — core (fault-injection 10/10, RED→GREEN) + Console foundation → DoD ผ่าน 2026-07-04
      (fail-closed มี test + พิสูจน์สด · projects/sessions/quota โชว์จริง · red warning จริง ไม่รั่ว secret)
- [x] Phase 1 — AAL + conformance 8/8 + anthropic adapter + context builder + Human Plane API +
      F-Term (live-verified) + governance pages + supervised loop 3/3 → DoD ผ่าน 2026-07-04
      (หมายเหตุ: calibration เป็น bootstrap n=3 โดย operator-delegate — เฉลย/hidden golden ชุดจริง
      จากมนุษย์ยังต้องเติมเมื่อผู้ใช้กลับมา ตาม kickoff ข้อ 7.8)
- [x] Phase 2 — breaker/quota-aware router + hypothesis repair + merge policy L0-L4 +
      meta-governance + steering + canary/dep-policy + Console F-MCP/F-Hook(consent)/F-Sub/F-Skill/
      F-Sys + automation guards → DoD ผ่าน 2026-07-05: semiauto loop L1 auto-merge + sampling audit +
      reproduce-before-COMPLETED รันจริง · breaker/guards มี test ครบ · hook/MCP/subagent เขียนไฟล์ valid
- [x] Phase 3 — DoD ผ่าน 2026-07-05 (มี pending-human 1 ข้อ):
      auditor จับ non-repro ได้ (test) · merge queue serialize + attribution · fusion self-panel
      วัดจริง (uplift ไม่ปรากฏที่ n=1 → คง OFF ตามนโยบาย §7.5, .ai/calibration/fusion-measure-*.json) ·
      F-Loop อนุมัติ approval ผ่าน console→Human Plane จริง · F-Sched start/stop + quota guard ·
      remote auth Basic (scrypt+HMAC) พิสูจน์สดบน 192.168.64.1: no-auth=401, login→200,
      /terminal=401, host-guard=403 · adapters openai-compatible/_template เขียนแล้ว **unverified**
      (D-007 — รอ credentials) · **รอมนุษย์:** login/approve จากเครื่องอื่นจริง (D-008)

### Security checklist §13.3 — สถานะ (2026-07-05)

ผ่าน: default bind loopback · fail-closed no-provider (มี test) · host-header guard · WS single-use
ticket + 4403 · audit (auth login, PTY spawn/attach/kill, settings/hooks/permissions writes,
approvals, sched, kill) · consent gate hooks (428) · ไม่มี endpoint แสดง/export token · single-operator ·
rate limit (login 5/min, PTY 5/10s, Human Plane 200/10s) · cookies HttpOnly+SameSite=Lax ·
core vendor-free CI · autonomous ไม่แตะ Claude Code execution (tools:[] + P6) · interactive approval
= CLI-native ใน F-Term
บางส่วน/หมายเหตุ: `Secure` cookie ต้องมี HTTPS — แนะนำ reverse proxy/TLS เมื่อเปิด remote จริง ·
peer-IP guard บน loopback ยังไม่ทำ · redaction sweep แบบ system-wide เป็น pattern-based เฉพาะจุด ·
F-Sched first-enable confirmation เป็น API guard (หน้า UI confirm ยังไม่มี)
- [x] Phase 4 — กลไก continuous ครบ 2026-07-05: planning gate §11.2 (uncovered ACs/orphans/
      diff budget) · lessons governance (confirmed-hypothesis-only → human approve → inject เป็น
      marked data) · outcome routing shadow (observe-only, activation ต้องมนุษย์ + n>=50) ·
      rollback path (state machine + scripts/rollback-worktree.sh + drift detection) ·
      **ตัดโดยเจตนา (§16 อนุญาต, รอมนุษย์ยืนยัน):** F-Chat (optional non-parity), themes/
      responsive/i18n, canary deploy จริง (ยังไม่มี prod target — กลไก rollback พร้อมแล้ว)

## สถานะปิดงาน AFK (2026-07-05)

ทุกเฟส 0-4 สร้างครบตามสเปกในขอบเขตที่ทำได้โดยไม่มีมนุษย์ · CI เขียว 72 tests ·
hard gates ทุกตัวผ่าน · invariants ไม่มีข้อไหนถูกละเมิด (INV-7 มี CI ตรวจ, INV-2/9/12/14/15/16/17
มี test/พิสูจน์สด)

**รายการรอมนุษย์ (ตาม kickoff ข้อ 7.8 — agent ผลิตแทนไม่ได้):**
1. เฉลย + hidden golden ของ calibration suite ชุดจริง (§12) — ตอนนี้เป็น bootstrap n=3+1 โดย
   operator-delegate (ช่วงกว้าง ไม่ใช่ rate)
2. login/approve จากเครื่องอื่นจริง (D-008 — พิสูจน์แล้วระดับ non-loopback IP บนเครื่องเดียว)
3. ยืนยัน default 4 ข้อ D-001..D-004 + การตัด Phase 4 polish ข้างบน
4. credentials ของ vendor อื่นถ้าต้องการ quota-survivability จริง (D-007) → รัน conformance ก่อนใช้
5. review PR จาก branch build/platform (กฎ: ห้าม merge โดยไม่มี review)

## Checkpoint 2026-07-05 — Console SPA เต็มตาม §8

ผู้ใช้ชี้ว่าหน้า Console ยังเป็น Phase-0 landing → สร้าง SPA เดียวครบทุก F-page ตามตาราง §8:
F-Status/F-Proj(register+loop-managed banner)/F-Sess(rename/tag/fork/export/delete + FTS5 search)/
F-Term(launcher+attach/kill)/F-Set(scope picker+effective view+apply-timing)/F-Perm(builder+merged+
simulator+protect-golden)/F-Auth/F-Mem/F-MCP/F-Hook(read view+consent builder)/F-Sub/F-Skill/
F-Usage(HUD+breakdown วัน/โปรเจกต์/โมเดล+alerts)/F-Act(SSE feed+one-click hooks fail-open)/
F-Loop(Approve/Reject/Steer/Kill)/F-Sched/F-Sys(retention write) · deep-link ?project= ทุกหน้า ·
background ops = action + poll /api/actions/{id}/status · Human Plane เพิ่ม POST /steer ·
พิสูจน์สด: ทุกหน้า render บน browser จริง, index 716 sessions/6s, search + per-model breakdown
คืนข้อมูลจริง · CI เขียว (85 tests) · F-Chat ยังตัดตาม §16 (optional non-parity, รอมนุษย์ยืนยัน)

## Checkpoint 2026-07-05 (2) — UX/UI modernization + adversarial review

Redesign SPA: design tokens (light/dark), sidebar + sticky topbar + SVG icons, KPI cards, bar
charts ใน Usage, modal dialogs แทน prompt/confirm (role=dialog + focus trap + Escape + restore),
skeleton loading, relative timestamps, empty states, responsive drawer (mobile) ·
ultracode review panel (24 agents, 3 lens): confirmed 19 defects → แก้ครบ: stored XSS
(cleanupPeriodDays attr — esc+Number ทั้ง UI และ backend type-guard), navigation-generation
token กัน stale continuation เขียนข้าม page (Settings JSON เคยหลุดลง CLAUDE.md editor ได้),
double-route จาก project link, 401 poller เคยลบ password ที่พิมพ์อยู่, confirm dialog ให้
sched stop / hooks uninstall / terminal kill (ผ่าน api()), aria-live toasts, focus-visible,
aria-label ทุก input, touch target >=30px, mobile topbar wrap + card overflow ·
พิสูจน์สด: 17 หน้า render + modal Escape/focus + race test + single-route ผ่านหมด · CI เขียว 85

## Session log

- 2026-07-04 — session 1: อ่านสเปกจบ · branch `build/platform` · ไฟล์ควบคุม + Build Plan · เริ่ม spikes
