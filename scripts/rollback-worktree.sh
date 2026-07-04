#!/bin/sh
# rollback-worktree.sh (§14): discard a task worktree back to its checkpoint.
# Usage: rollback-worktree.sh <worktree-dir>
set -eu
WT="$1"
[ -d "$WT" ] || { echo "no such worktree: $WT" >&2; exit 1; }
if [ -d "$WT/.git" ]; then
  git -C "$WT" reset --hard HEAD >/dev/null
  git -C "$WT" clean -fd >/dev/null
  echo "rolled back git worktree $WT"
else
  echo "non-git worktree: rebuild from event-log evidence (auditor cleanCheckout)" >&2
  exit 2
fi
