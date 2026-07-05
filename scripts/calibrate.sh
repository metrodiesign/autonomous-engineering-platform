#!/bin/sh
# calibrate.sh (§12 / §14): run the calibration suite and stamp the record with the systemVersion,
# so held-out pass rates are comparable across upgrades (§12). Thin wrapper over run-supervised-loop.mjs.
# Usage: calibrate.sh [model]
set -eu
cd "$(dirname "$0")/.."

MODEL="${1:-haiku}"

# systemVersion = hash(core + policies), read from built core (dist) — see core/src/system-version.ts
VERSION=$(node -e "import('./core/dist/system-version.js').then(m => process.stdout.write(m.computeSystemVersion(process.cwd())))")
[ -n "$VERSION" ] || { echo "could not compute systemVersion (build core first: pnpm --filter @platform/core build)" >&2; exit 1; }

echo "calibration systemVersion=$VERSION model=$MODEL"

# run the supervised calibration loop (marks the run as calibration for downstream tooling)
CALIBRATION=1 node scripts/run-supervised-loop.mjs "$MODEL"

# stamp the produced record with the systemVersion in its filename
SRC=$(find .ai/calibration -name "bootstrap-$MODEL-*.json" -type f | sort | tail -n1)
[ -n "$SRC" ] || { echo "no calibration record produced" >&2; exit 1; }
DEST=".ai/calibration/cal-$(date +%Y%m%d)-$VERSION.json"
cp "$SRC" "$DEST"
echo "calibration stamped: $DEST"
