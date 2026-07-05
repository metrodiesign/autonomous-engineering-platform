#!/bin/sh
# rollback-worktree.sh (§14): discard a task worktree back to its checkpoint.
# Usage: rollback-worktree.sh <worktree-dir>
set -eu
WT="$1"
[ -d "$WT" ] || { echo "no such worktree: $WT" >&2; exit 1; }
# a linked worktree (from create-worktree.sh) has a .git FILE, not a dir — detect via git itself
if git -C "$WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$WT" reset --hard HEAD >/dev/null
  git -C "$WT" clean -fd >/dev/null
  echo "rolled back git worktree $WT"
else
  echo "non-git worktree: rebuild from event-log evidence (auditor cleanCheckout)" >&2
  exit 2
fi
