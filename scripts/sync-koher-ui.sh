#!/usr/bin/env bash
# Sync the canonical Koher UI stylesheet into the Sensorium frontend
# at build time. Source of truth lives at /ui-system/koher-ui.css.
# This script copies it into src/assets/koher-ui.css so the renderer
# can load it locally at runtime.
#
# Run before each build: handled automatically by tauri.conf.json's
# beforeBuildCommand. Manual run: `bash scripts/sync-koher-ui.sh`
# from the sensorium/ directory.

set -euo pipefail

# Resolve paths
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SENSORIUM_ROOT="$(cd "${HERE}/.." && pwd)"
# Build folder moved 13 May 2026 from tools-scratch/02-sensorium/sensorium/
# (4 levels deep from koher root) to tools-release/sensorium/ (2 levels deep).
# Adjust relative depth accordingly.
KOHER_ROOT="$(cd "${SENSORIUM_ROOT}/../.." && pwd)"

SRC="${KOHER_ROOT}/ui-system/koher-ui.css"
DST="${SENSORIUM_ROOT}/src/assets/koher-ui.css"

if [ ! -f "${SRC}" ]; then
  # Source not reachable. This is the expected case on CI runners
  # (GitHub Actions checks out only the sensorium repo, not the koher
  # monorepo, so /ui-system/ doesn't exist relative to this script).
  # From v0.1.7 onward src/assets/koher-ui.css is vendored into the
  # repo — if that vendored copy is present, trust it and exit zero.
  # Otherwise fail loudly so a misconfigured local dev environment
  # gets caught early.
  if [ -f "${DST}" ]; then
    echo "ℹ source ${SRC} not reachable; vendored copy at ${DST} will be used as-is (expected on CI)"
    exit 0
  fi
  echo "✗ source not found: ${SRC}"
  echo "  and no vendored fallback at: ${DST}"
  exit 1
fi

mkdir -p "$(dirname "${DST}")"
cp "${SRC}" "${DST}"
echo "✓ synced koher-ui.css → ${DST}"
echo "  source: ${SRC}"
