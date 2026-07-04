# DEVIATIONS

> ทุกจุดที่ implementation ต่างจากสเปก พร้อมเหตุผล: พฤติกรรมจริงของ CLI/SDK (§0.6) ·
> เปลี่ยน default ระดับ "ควร" (§0.2) · deviation ที่ผู้ใช้สั่ง (§1.2)

## DEV-001 — `allowedTools: []` ไม่ได้ปิด tool ตามที่สเปกเข้าใจ (SDK 0.3.201)

- **สเปก (§5.2 ข้อ 2, §15.5, INV-9):** สั่งใช้ `allowedTools: []` เพื่อ "ปิด execution ทั้งหมด...ไม่ส่ง tool definitions"
- **พฤติกรรมจริง (SDK 0.3.201, ตรวจจาก sdk.d.ts + spike 5 รันจริง):** `allowedTools` คือรายการ tool ที่
  *auto-allow โดยไม่ถาม permission* — ค่า `[]` ไม่ตัด tool ออก; init message ยังรายงาน tools ครบ ~29 ตัว
- **กลไกที่ถูกต้อง:** `tools: []` ("Disable all built-in tools" ตาม docs ของ SDK) — ตัด tool definitions
  ออกจาก context จริง
- **ผล:** adapter (§5.2) และ conformance P6 ต้องใช้ `tools: []` (+ `settingSources: []`) เป็นกลไกหลัก;
  ทุกที่ที่สเปกเขียน `allowedTools: []` ให้อ่านเป็น `tools: []`
- **Invariant ไม่กระทบ:** INV-9 (no execution authority) บรรลุด้วย `tools: []` — พิสูจน์ใน spike 5
