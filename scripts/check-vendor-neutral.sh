#!/bin/sh
# INV-7: core/ (Ring 0) must not mention any vendor name. CI-enforced.
set -eu
cd "$(dirname "$0")/.."
MATCHES=$(grep -riE 'claude|anthropic|codex|glm|openai' core/src core/test 2>/dev/null || true)
if [ -n "$MATCHES" ]; then
  echo "INV-7 VIOLATION — vendor names found in core/:"
  echo "$MATCHES"
  exit 1
fi
echo "INV-7 OK: core/ is vendor-neutral"
