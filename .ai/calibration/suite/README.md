# Calibration Suite (spec §12)

The neutral yardstick for "is the autonomous loop actually good?". A set of held-out
tasks whose **hidden golden tests are authored by a human**, run by the system, and
graded by those golden tests. The result is a **held-out pass rate** that every phase
gate cites and that blocks an upgrade when it regresses past threshold.

This directory is the scaffold. The machinery is done; the answer key is yours to write.

## Why a human must author the golden

If the system authors both the task and the test that grades it, it grades itself — the
exact fake-green failure §11 warns about. The value only a human adds here is
**authorship independence**: tasks and hidden golden the system has never seen.

## Files

- `CAL-01.json` — a complete worked example (authored). Copy its shape.
- `CAL-02.json` .. `CAL-20.json` — stubs. `visible` and `golden` are `TODO_AUTHOR`.
- `task.schema.json` — the field contract (draft-07).

The loader skips any task whose `visible`/`golden` is still `TODO_AUTHOR`, so you can
author and run a few at a time.

## Task fields

| field | meaning |
|-------|---------|
| `id` | `CAL-NN`. Matches the filename. |
| `goal` | The prompt handed to the agent. Must be unambiguous. |
| `constraints` | Handed to the agent (e.g. ESM, no dependencies). |
| `expect` | Final state a correct run reaches. `REVIEWING` for build tasks; `REJECTED`/`ESCALATED` for refusal tasks. |
| `visible` | The RED test the agent sees (T0). **Weaker** than golden. |
| `golden` | The hidden held-out test (T1). **Never shown to the agent.** The truth. |
| `notes` | What the golden should stress. Guidance, not runtime data. |

## Authoring rules

1. **Golden is stricter than visible.** If they are identical, the task measures nothing —
   an agent that overfits the visible test still passes. Put the easy case in `visible`,
   the edge cases (empty, negative, boundary, unicode, precedence...) in `golden`.
2. **Deterministic only.** Pure functions, fixed inputs/outputs. No time, network, or fs —
   they make golden results flaky and un-gradeable.
3. **Tests are `node --test`, ESM `.mjs`, zero dependencies.** They run in an ephemeral
   worktree. Import the target as `../../src/<file>.mjs` (both tests sit two levels deep).
4. **10–20 tasks.** Fewer than 10 → the rate is a wide interval, not a number; the runner
   labels it as such.
5. Review the seeded `goal`/`notes` too — replace anything you would not stand behind.

## Keeping the golden hidden

At run time the agent only receives the `goal` and the `visible` seed — never the golden
(the runner writes golden into `test/golden/` of a throwaway worktree the agent's context
does not include). The remaining leak is **this repo**: do not point an interactive
session or the platform's context-builder at `.ai/calibration/suite/`, or a model could
read the golden and overfit. `POST /api/permissions/protect-golden` installs
`deny Write/Edit test/golden/**`; treat this directory the same way — read-restricted.

## Run

```sh
# author some tasks first, then:
scripts/calibrate.sh haiku
```

Produces `.ai/calibration/cal-<date>-<systemVersion>.json`, stamped with
`systemVersion = hash(core + policies)` so results are comparable across upgrades.

## Gate on regression

```sh
node scripts/compare-calibration.mjs <baseline.json> <current.json>
```

Exit 1 if any metric regressed → block the upgrade. Set the first good run as the
baseline; re-run before every core/policy/prompt change.
