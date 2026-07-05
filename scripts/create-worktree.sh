#!/bin/sh
# create-worktree.sh (§14): isolate a task in its own git worktree + branch.
# Usage: create-worktree.sh <task-id> [base-ref]
# Prints the created worktree path on stdout (one line) so callers can capture it.
set -eu

TASK="${1:?usage: create-worktree.sh <task-id> [base-ref]}"
BASE="${2:-HEAD}"
DIR="worktrees/$TASK"
BRANCH="task/$TASK"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repo" >&2; exit 1; }

# refuse a dirty/occupied target: never clobber existing work
[ -e "$DIR" ] && { echo "target already exists: $DIR" >&2; exit 1; }
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "branch already exists: $BRANCH" >&2
  exit 1
fi

git worktree add -b "$BRANCH" "$DIR" "$BASE" >/dev/null
echo "$DIR"
