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
- [ ] Phase 2 — security plane เต็ม + breaker + hypothesis repair + auto-merge L0-L1 + Console ext → DoD
- [ ] Phase 3 — multi-model + fusion + merge queue + auditor + F-Loop + remote auth §13 → DoD
- [ ] Phase 4 — continuous + polish (ไม่มี DoD เฉพาะ — ใช้ gate กลาง §14, มนุษย์ยืนยันเกณฑ์)

## Session log

- 2026-07-04 — session 1: อ่านสเปกจบ · branch `build/platform` · ไฟล์ควบคุม + Build Plan · เริ่ม spikes
