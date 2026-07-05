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

## DEV-002 — Console editor endpoints are excluded from the INV-14 redaction sweep

- **Spec (§13.3 / INV-14):** "Redaction covers every Console response/log + credential-file paths."
- **Deviation:** The redaction sweep (`console/backend/src/redact.ts`) is applied to read/transcript/
  event surfaces (`/api/sessions/:id/messages`, `/export`, `/api/sessions/search`, `/api/events`,
  `/api/system` doctor, `/api/loop/events`) but **NOT** to the settings / memory / permissions /
  MCP editor GET->edit->PUT round-trip (`governance.ts`, `extensions.ts` F-MCP).
- **Why:** those endpoints exist to read a config file, let the operator edit it, and write it back.
  Masking a real on-disk secret to `***REDACTED***` on GET and then PUT-ing that back would overwrite
  the live credential with the sentinel and corrupt the file. Redaction there is unsafe, not omitted.
- **Why it's acceptable:** the Console is single-operator (INV-15) and, when bound non-loopback, fully
  authenticated (§13.1); the editor never broadcasts these values to a third surface.
- **Reversible knob for a human:** if a future multi-viewer mode is added, add display-only redaction on
  the GET path with a paired "unchanged sentinel => keep on-disk value" guard on the PUT path.

## DEV-003 — F-Term Windows/ConPTY path is unverified on this host (claim discipline §16)

- **Spec (§4.1 line 148, §8):** "Cross-platform: POSIX via pty; **Windows via ConPTY** (node-pty supports it) —
  verify real behavior per version." INV-17 requires the interactive surface to be 100% CLI parity via PTY.
- **Deviation:** the platform depends on `node-pty` 1.1.0 (`console/backend/package.json`), which drives
  ConPTY natively on Windows. This host is developed and tested on darwin only; the Windows/ConPTY path
  (PTY spawn of the real `claude` binary, attach/detach, resize, reap, WS ticket flow) has **not been run**
  on a Windows machine. POSIX PTY parity was proven by spike 2 (§15, `spikes/RESULTS.md`); the Windows
  equivalent has no such evidence yet.
- **Why it's recorded, not claimed:** §16 claim discipline forbids asserting a capability we have not
  exercised. We therefore do **not** claim Windows parity — it is an untested surface, not a supported one.
- **What must happen before claiming Windows support:** run spike 2 (PTY parity proof) on Windows against
  `node-pty` 1.1.0 — confirm slash commands, `claude --resume`, permission-prompt render/answer, detach +
  re-attach, clean reap, and the single-use WS ticket all behave as on POSIX — then remove this deviation.
- **Invariant not weakened:** INV-17's auth-everywhere guarantee (remote must authenticate, including
  `--insecure`) is OS-independent and already enforced; only the OS-specific PTY behavior is unverified.
