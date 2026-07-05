# src/

This directory is the target-project slot in the platform repo tree (§14): it is where the code
of the project the platform is building lives, not where the platform itself lives. The platform's
own code sits in `core/` (Ring 0, deterministic, vendor-neutral), `aal/` (Ring 1 adapter layer),
`adapters/` (Ring 2 vendor adapters), and `console/` (operator surface); calibration and demo loops
create their own throwaway worktrees under a temp dir and write generated code into that worktree's
`src/`. This top-level `src/` exists so the repository matches the §14 structure and so a real goal
run has a conventional place for target-project sources alongside `test/ai-generated/` and `test/golden/`.
