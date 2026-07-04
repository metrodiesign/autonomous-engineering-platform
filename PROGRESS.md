# PROGRESS

> ไฟล์ควบคุมตาม build-kickoff-prompt.md ข้อ 4 — อัปเดตทุก checkpoint

## สถานะปัจจุบัน

- **Phase:** Phase 0 เสร็จ — DoD ผ่านครบ · กำลังเริ่ม Phase 1
- **ทำล่าสุด:** core fault-injection 10/10 GREEN (RED-first) · Console foundation live-verified
  (fail-closed 0.0.0.0 ✓, 42 projects, sessions, usage estimate, API-key red warning ไม่รั่วค่า ✓)
- **ถัดไป:** Phase 1 — ทบทวนนโยบาย non-interactive credit (D-004) → AAL protocol + conformance
  P1–P8 + adapters/anthropic.ts (ใช้ tools:[] ตาม DEV-001) + context builder + Human Plane API +
  F-Term PTY + governance pages + supervised loop + calibration แรก

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
- [ ] Phase 1 — AAL + conformance P1-P8 + anthropic adapter + context builder + Human Plane API + F-Term → DoD
- [ ] Phase 2 — security plane เต็ม + breaker + hypothesis repair + auto-merge L0-L1 + Console ext → DoD
- [ ] Phase 3 — multi-model + fusion + merge queue + auditor + F-Loop + remote auth §13 → DoD
- [ ] Phase 4 — continuous + polish (ไม่มี DoD เฉพาะ — ใช้ gate กลาง §14, มนุษย์ยืนยันเกณฑ์)

## Session log

- 2026-07-04 — session 1: อ่านสเปกจบ · branch `build/platform` · ไฟล์ควบคุม + Build Plan · เริ่ม spikes
