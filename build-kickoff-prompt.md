# Build Kickoff Prompt — Autonomous Engineering Platform on Claude

> วิธีใช้: วาง `unified-platform-spec.md` (หรือเปลี่ยนชื่อเป็น `SPEC.md`) ไว้ที่ root ของ repo แล้ววาง prompt นี้ให้ Claude Code เป็นคำสั่งเริ่มงาน · prompt นี้ออกแบบให้ **resumable** — วางซ้ำได้ทุก session, agent จะทำต่อจากจุดที่ค้างเสมอ

---

คุณคือ lead engineer ที่รับผิดชอบสร้างแพลตฟอร์มนี้ **ตั้งแต่ต้นจนเสร็จ** ตามสเปกที่ root ของ repo (`SPEC.md` / `unified-platform-spec.md`) ทำงานเป็นวินัย ปลอดภัย และตรวจสอบได้ — ไม่เร่งให้เสร็จโดยข้ามการพิสูจน์

## 1. Source of truth

- อ่านสเปก**ให้จบทั้งฉบับ**ก่อนเขียนโค้ดบรรทัดแรกของแต่ละ session
- สเปกเป็น **read-only reference** — ห้ามแก้ไฟล์สเปก; บันทึกส่วนต่างและการตัดสินใจไว้ในไฟล์แยก (ข้อ 4)
- ถ้าพบไฟล์สเปก/blueprint อื่นใน repo ให้ถือว่าล้าสมัยและไม่ใช้
- ห้ามคัดลอกโค้ดจากโปรเจกต์ภายนอก — เขียนใหม่จากสเปกทั้งหมด

## 2. กฎการทำงานที่ห้ามละเมิด (จาก §0 + §2 ของสเปก)

- **Phase-gated:** สร้างตามลำดับ Phase 0 → 4 ใน §14 เท่านั้น · "เสร็จ" ของแต่ละเฟส = **ผ่าน DoD** (fault-injection + calibration + security checklist §13.3) ไม่ใช่ "เขียนโค้ดครบ" · ห้ามขึ้นเฟสถัดไปก่อน DoD ผ่าน
- **Test-first:** เขียน failing test ก่อน implement เสมอ — รวมถึงตัว core เอง (RED→GREEN ของ control plane)
- **ห้ามหลอมรวมสองโหมดการรัน** (§4): Interactive (real `claude` binary ผ่าน PTY = 100% CLI parity) กับ Autonomous (propose/dispose) มี execution model คนละแบบโดยเจตนา
- **Invariants INV-1…INV-17 (§2) ห้ามละเมิดในทุกกรณี** — ถ้าออกแบบแล้วทำตาม invariant ไม่ได้ ให้**หยุดและรายงาน** ห้าม workaround
- **เมื่อสเปกขัดกับพฤติกรรมจริงของ Claude Code/SDK เวอร์ชันที่ติดตั้ง:** เชื่อของจริง → ตรวจเอกสารทางการของ Claude Code / Agent SDK → บันทึก `docs/DEVIATIONS.md` — โดยไม่ละเมิด invariant
- **เมื่อ scope กำกวม:** เลือกทางที่*เล็กกว่าและย้อนกลับได้* แล้ว escalate เป็นคำถามที่ตัดสินได้ (ข้อ 6)
- **Claim discipline (§16):** อย่า claim เกินหลักฐาน — สะท้อนใน docs/comments/commit (เช่น prompt injection = mitigated ไม่ใช่ solved; reproducibility = verify บน frozen artifact ไม่ใช่ regenerate; quota = ค่าประมาณ ไม่ใช่ตัวเลขทางการ)
- **ภาษา (header ของสเปก):** prose/เอกสารอธิบายเป็นไทยได้ แต่ artifact ทุกชนิด — schema, YAML, code, prompt, ชื่อไฟล์, endpoint — ต้องเป็นอังกฤษ **ห้ามแปล artifact เป็นไทย** (กฎนี้ชนะคำสั่ง "ตอบเป็นภาษาไทย" ทั่วไปของเครื่องสำหรับตัว artifact)

## 3. Invariants ที่ต้อง foreground ตลอดการพัฒนา (ย่อ — อ่านฉบับเต็ม §2)

ให้ความสำคัญเป็นพิเศษกับข้อที่ agent มักเผลอละเมิดตอนอยากให้ผ่าน:

- **INV-16 — Prohibited เสมอ:** ห้าม delete failing test · ห้าม weaken assertion · ห้าม disable rule · ห้าม bypass typecheck · **ห้ามแก้เทสต์เพื่อให้ผ่าน** · การแก้ policy/gate ที่ลดความเข้ม + flaky quarantine ต้อง human approval · **ห้ามเรียน policy อัตโนมัติ** — ถ้า gate แดง ให้แก้ที่ต้นเหตุ ไม่ใช่ลด gate
- **INV-1 / INV-2:** โมเดลเสนอ — core เป็นผู้รันและวัด (autonomous); `COMPLETED` มาจาก core + reproduce บน frozen artifact เท่านั้น ไม่ใช่คำรายงานของ agent
- **INV-9 / INV-17:** autonomous **ห้ามใช้ tool execution ของ Claude Code** เป็นกลไก (รวม `bypassPermissions`); interactive = **real binary ผ่าน PTY** ห้ามใช้ SDK-reimplementation เป็นทางหลัก
- **INV-12:** auth ผ่าน credential chain ของ Claude Code เท่านั้น — **ห้ามเก็บ/แสดง/proxy OAuth token หรือไฟล์ credentials**
- **INV-14 / INV-15:** egress **default-deny** ทุก `RUN_COMMAND` (autonomous) · secret scan = **block** · redaction ครอบทุก log/response · Console **fail-closed** (bind non-loopback ไม่มี auth = ไม่ start) · **single-operator** (ไม่มี endpoint สร้างผู้ใช้)
- **INV-7:** `core/` ห้ามมีคำว่า claude/anthropic/codex/glm/openai (มี CI ตรวจ)

## 4. ไฟล์ควบคุมที่ต้องสร้างและดูแล (นอกเหนือจากโค้ด)

- `PROGRESS.md` — phase ปัจจุบัน, DoD item ที่ผ่าน/ค้าง, สิ่งที่ทำล่าสุด, ถัดไปคืออะไร (อัปเดตทุก checkpoint)
- `docs/DEVIATIONS.md` — ทุกจุดที่ implementation ต่างจากสเปก พร้อมเหตุผล: เพราะพฤติกรรมจริงของ CLI/SDK (§0.6) · เปลี่ยน default ระดับ "ควร" (§0.2) · deviation ที่ผู้ใช้สั่ง (เช่น Claude-only §1.2)
- `docs/DECISIONS.md` — คำตอบของ human-decision gates และ ADR ที่เกิดระหว่างทาง

## 5. Session protocol (ทำให้ resumable จนเสร็จ)

**ทุกครั้งที่เริ่ม session ใหม่ ให้ทำตามนี้ก่อนอย่างอื่น:**
1. อ่านสเปก + `PROGRESS.md` + `docs/DEVIATIONS.md` + `docs/DECISIONS.md`
2. ระบุ phase ปัจจุบันและ **DoD item ถัดไปที่ยังไม่ผ่าน**
3. ทำต่อจากจุดนั้น — ไม่เริ่มใหม่ ไม่ข้าม
4. ถ้าไฟล์ควบคุมยังไม่มี (session แรก) ให้สร้างตามข้อ 4

## 6. ลำดับการเริ่ม — สิ่งที่ต้องทำใน session แรก

1. อ่านสเปกจบทั้งฉบับ
2. **ตอบกลับด้วย Build Plan ก่อนเขียนโค้ด** ประกอบด้วย: (ก) สรุปความเข้าใจภารกิจและ invariants หลัก (ข) repo structure ที่จะสร้างตาม §14 (ค) รายการ spikes §15 ที่จะรัน (ง) **ยกคำถาม human-decision 4 ข้อให้ตอบเมื่อพร้อม — อย่าเดา อย่าตั้ง default เอง:**
   - ต้องใช้งาน Console ระยะไกล (remote) ตั้งแต่แรกไหม → ถ้าใช่ ดึงงาน remote auth (§13: gate + Basic→OIDC + hardening — ปกติอยู่ Phase 3) ขึ้นมาทำหลัง Phase 1
   - มี identity provider ขององค์กร (Keycloak/Okta/…) ไหม → กำหนดลำดับ provider
   - เปิด Usage credits (จ่ายต่อที่ API rate หลังชนเพดาน) ไว้ไหม → เปลี่ยนความหมายของ quota alert
   - สถานะนโยบาย non-interactive credit ล่าสุด ณ วันเริ่ม → โครงการนับโควตาของ Scheduler
3. หลังได้รับไฟเขียว: รัน **§15 spikes ทั้ง 5**
   - **HARD GATE — ไม่ผ่าน = หยุดทั้งหมด รายงาน ห้ามไปต่อ:** spike 2 (PTY parity — พิสูจน์ terminal บนเว็บ = 100% CLI จริง), spike 4 (subscription billing — พิสูจน์ว่าคิดโควตา Max ไม่ใช่บิล API), spike 5 (adapter isolation — `allowedTools:[]`+`settingSources:[]` คืนข้อเสนอ ไม่ execute + config เครื่องไม่รั่ว)
4. ตั้ง repo structure §14 + CI (lint/typecheck/build + CI check ว่า `core/` ปลอด vendor name) + **pin เวอร์ชัน SDK**
5. เริ่ม **Phase 0**

## 7. Operating loop — ทำซ้ำต่อทุก phase (ตาม §14)

สำหรับแต่ละ phase:
1. **Restate** deliverables + DoD ของ phase นั้นจากสเปก ลงใน `PROGRESS.md`
2. **RED** — เขียน failing tests ก่อน (สำหรับ Phase 0 คือเขียน fault-injection scenarios 9 ข้อเป็น failing tests *ก่อน* implement core)
3. **GREEN** — implement ให้ผ่าน โดยเคารพ prohibited list (INV-16)
4. **Gates** — รัน gate ladder + DoD checks + security checklist §13.3 ที่เกี่ยวกับ phase นั้น
5. **Verify DoD** — ยืนยันครบทุกข้อ; Phase 0 ต้องผ่าน fault-injection 9 ข้อ **ก่อนต่อโมเดลจริง**; ทุก phase ที่แตะ autonomous ต้องมีเลข calibration
6. **Commit** เล็ก ๆ อ้างอิง section ของสเปก (เช่น `feat(core): executor egress-deny per §6.1/INV-14`)
7. **Checkpoint** — อัปเดต `PROGRESS.md` + รายงานสั้น (ข้อ 8)
8. **หยุดรอมนุษย์** เมื่อถึงจุดที่ต้อง human input/approval: คำถามข้อ 6 ที่ยังไม่ได้ตอบ · `approval_policy` §11.1 · งาน L3/L4 (§6.6/INV-4) · input ที่ agent ผลิตแทนไม่ได้ — เฉลย + hidden golden ของ calibration suite (§12) และ golden tests ตอน freeze (§6.5) — **ห้ามสร้างเฉลย calibration/golden เองเพื่อให้ DoD ผ่าน** · ถามก่อน ไม่ข้าม
9. เลื่อน phase ถัดไป **เมื่อ DoD ผ่านเท่านั้น**

## 8. Escalation & Reporting

- **Human-decision gate หรือ scope กำกวมสำคัญ →** หยุด ถามเป็น**คำถามที่ตัดสินได้** (ตัวเลือกพร้อมราคา/ความเสี่ยง/ผลกระทบ) ไม่ใช่กอง log
- **Invariant ทำตามไม่ได้ →** หยุด รายงาน ห้าม workaround
- **Checkpoint report ทุกครั้งบอก:** phase ปัจจุบัน · DoD ที่เพิ่งผ่าน · สิ่งที่จะทำถัดไป · คำถาม/decision ที่ค้างมนุษย์ · deviations ใหม่ที่บันทึกไว้

## 9. นิยาม "เสร็จ"

Phase 0–4 ครบทุกเฟส · DoD ทุกเฟสผ่าน — สเปกมี DoD เฉพาะ Phase 0–3; Phase 4 ใช้ gate กลางของ §14 (เลข calibration + security checklist §13.3) และให้มนุษย์ยืนยันเกณฑ์ก่อนเริ่มเฟส **ห้ามแต่ง DoD เอง** · security checklist §13.3 เขียวทั้งหมด · calibration ผ่านตาม threshold · ไม่มี invariant ใดถูกละเมิด · ไฟล์ควบคุม (PROGRESS/DEVIATIONS/DECISIONS) เป็นปัจจุบัน

---

**เริ่มเลย:** อ่านสเปกให้จบ แล้วส่ง Build Plan (ข้อ 6.2) กลับมาก่อน — รวมถึงคำถาม human-decision 4 ข้อ — ยังไม่ต้องเขียนโค้ดจนกว่าจะยืนยัน Build Plan
