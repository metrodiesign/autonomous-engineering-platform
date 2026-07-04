# DECISIONS

> คำตอบ human-decision gates + ADR ระหว่างทาง (kickoff ข้อ 4) · ทุกข้อพลิกได้ — บันทึกไว้ให้ผู้ใช้ทบทวน

## D-000 — โหมด AFK (บริบทของทุกการตัดสินใจด้านล่าง)

2026-07-04 ผู้ใช้สั่ง: "รัน kickoff prompt ตามแผนงานทั้งหมดโดยไม่ต้องถามฉัน ฉันไม่ได้อยู่หน้าจอ"
→ override ขั้นตอน "รอไฟเขียว Build Plan" ของ kickoff ข้อ 6 · คำถาม human-decision 4 ข้อใช้ default
ที่*เล็กกว่าและย้อนกลับได้* (ตามกติกา §0.7 ของสเปก) แทนการรอคำตอบ · ทุก default ด้านล่างพลิกได้ภายหลัง

## D-001 — Remote Console ตั้งแต่แรก? → ไม่

Default: bind `127.0.0.1` เท่านั้น (gate OFF ตาม §13.1) · remote auth (§13) คงอยู่ Phase 3 ตามสเปก
เหตุผล: เล็กกว่า ย้อนกลับได้ ปลอดภัยกว่า (F-Term = surface เสี่ยงสูงสุด) · พลิก: ดึง §13 ขึ้นมาหลัง Phase 1

## D-002 — Identity provider ขององค์กร? → ไม่มี

Default: ลำดับ provider = Basic (scrypt + HMAC session) ก่อน → OIDC ทีหลัง (ตาม §13.2)
เหตุผล: single-operator ส่วนบุคคล ไม่มีสัญญาณว่ามี Keycloak/Okta · พลิก: เพิ่ม OIDC config ได้ตอน Phase 3

## D-003 — Usage credits เปิดไหม? → ถือว่าปิด

Default: quota alert = "จะโดนบล็อกเมื่อชนเพดาน" (ความหมาย conservative กว่า)
เหตุผล: ตรวจจากเครื่องไม่ได้ (เป็น setting ฝั่งบัญชี) — ถือว่าปิดจนกว่าผู้ใช้ยืนยัน · พลิก: config flag
`usage_credits_enabled` เปลี่ยนข้อความ alert เป็น "จะเริ่มมีค่าใช้จ่าย"

## D-004 — นโยบาย non-interactive credit ณ วันเริ่ม? → นับ pool เดียว + label ทุก run

Default: ทุก run ของ adapter/scheduler ติด label interactive/non-interactive ตั้งแต่วันแรก (สเปกบังคับ §5.3)
+ นับโควตารวม pool เดียวกับ Max

**ทบทวนแล้ว 2026-07-04 (ก่อนเริ่ม Phase 1 ตาม §5.3):** แผนย้าย Agent SDK / `claude -p` / third-party
ไป monthly credit pool แยก (ประกาศ 14 พ.ค. 2026, มีผล 15 มิ.ย. 2026) **ถูกยกเลิกเมื่อ 15 มิ.ย. 2026** —
Help Center ยืนยัน surfaces เหล่านี้ยังกินจาก subscription pool ตามเดิม → default "pool เดียว" ถูกต้อง
ณ วันนี้ · Quota page ยังออกแบบรองรับ pool แยกได้ (สเปกบังคับ) · re-check อีกครั้งก่อนเปิด Fusion (§7.5)
อ้างอิง: support.claude.com/en/articles/15036540

## D-005 — Branch/commit policy

กฎ global ของผู้ใช้ห้าม commit ตรง main → ทำงานบน branch `build/platform` + commit เล็กอ้าง section
ตาม kickoff ข้อ 7.6 · ไม่ push (ไม่มี remote) · เปิด PR ให้ review ที่ milestone เมื่อผู้ใช้กลับมา

## D-006 — ตำแหน่ง spikes

`spikes/` standalone package ที่ root (ไม่อยู่ใน §14 structure — เป็นของ pre-Phase 1 เท่านั้น)
เหตุผล: กัน dependency ของ spike ปนเข้า workspace หลัก · ลบทิ้งได้หลังผ่าน gate
