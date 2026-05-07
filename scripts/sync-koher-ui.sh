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
KOHER_ROOT="$(cd "${SENSORIUM_ROOT}/../../.." && pwd)"

SRC="${KOHER_ROOT}/ui-system/koher-ui.css"
DST="${SENSORIUM_ROOT}/src/assets/koher-ui.css"

if [ ! -f "${SRC}" ]; then
  echo "✗ source not found: ${SRC}"
  exit 1
fi

mkdir -p "$(dirname "${DST}")"
cp "${SRC}" "${DST}"
echo "✓ synced koher-ui.css → ${DST}"
echo "  source: ${SRC}"
