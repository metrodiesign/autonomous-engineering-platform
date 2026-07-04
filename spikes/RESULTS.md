# Spike Results (§15) — 2026-07-04

| # | Spike | Verdict | หลักฐาน |
|---|-------|---------|---------|
| 1 | listSessions + getSessionMessages | **PASS** | 25 sessions, 50 msgs อ่านได้จริง (API เป็น Promise<Array> ไม่ใช่ async-iterable) |
| 2 | PTY parity (HARD) | **PASS** | 2a: spawn จริง + /model + /usage + permission prompt ตอบด้วยพิมพ์ + detach/attach · 2b: `--resume <id>` เปิด history เก่า · 2c: xterm.js บน browser จริง — พิมพ์ /model ผ่านเว็บ, ปิด tab → PTY อยู่, re-attach replay ครบ |
| 3 | query() streaming + canUseTool | **PASS** | 48 stream events, canUseTool fire กับ Write, deny แล้วไฟล์ไม่ถูกสร้าง |
| 4 | Subscription billing (HARD) | **PASS** | env ไม่มี API key ทุก run สำเร็จผ่าน `claude login` cred · /usage ก่อน–หลัง: session 18%→19%, weekly 71%→72% (โควตา Max ขยับ, ไม่มีสัญญาณบิล API) · /model โชว์ "Claude Max" |
| 5 | Adapter isolation (HARD) | **PASS** | `tools:[]`+`settingSources:[]` → NO_TOOLS, ข้อเสนอล้วน, ไฟล์ไม่ถูกสร้าง, canary config เครื่องไม่รั่ว |

## Learnings สำคัญ (ผูกเข้า implementation)

1. **`allowedTools:[]` ≠ ปิด tool** — ต้องใช้ `tools:[]` (DEVIATIONS DEV-001) — กระทบ §5.2/P6
2. **canUseTool ไม่ fire กับ read-only tool** ที่ auto-allow — approval hook ครอบเฉพาะ tool ที่ต้อง permission
3. **SDK ฉีด account context เล็กน้อย** (email + วันที่) แม้ `settingSources:[]` — adapter ตัด machine config ได้ แต่ตัด account metadata ไม่ได้ — บันทึกใน threat model (ไม่ละเมิด INV เพราะไม่ใช่ machine config/secret)
4. **node-pty ผ่าน pnpm: `spawn-helper` เสีย exec bit** — production ต้อง chmod/postinstall (F-Term Phase 1)
5. **PTY spawn ต้องการสิทธิ์นอก sandbox seatbelt** — Console backend รันเป็น process ปกติของผู้ใช้ (ตามสเปกอยู่แล้ว)
6. **Permission mode ของเครื่องผู้ใช้เป็น bypassPermissions** — F-Term ต้องไม่ assume default; parity = สืบทอด config จริงของเครื่อง (ตามเจตนา INV-17)
7. Project dir munging ของ transcript ใช้ realpath (`/var` → `/private/var`) + แทน `/` และ `.` ด้วย `-`

## Quota ณ เวลา spike เสร็จ: weekly all-models ~72%, มีตัวหนึ่ง 96% (จอ /usage) — automation ควรระวังก่อน window reset
