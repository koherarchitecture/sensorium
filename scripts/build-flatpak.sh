#!/usr/bin/env bash
# Build the self-hosted flatpak from the most recent .deb produced by
# `npx tauri build --bundles deb`.
#
# Version is read from package.json — keep package.json, tauri.conf.json,
# and src-tauri/Cargo.toml in sync; this script and the manifest then
# follow automatically.
#
# Architecture defaults to the host's Debian arch (via `dpkg --print-
# architecture`), so the script produces an arm64 flatpak on an arm64
# host and an amd64 flatpak on an amd64 host. Override with the ARCH
# env var or the first positional argument:
#
#   ARCH=arm64 bash scripts/build-flatpak.sh
#   bash scripts/build-flatpak.sh arm64
#
# Prereqs (Ubuntu 24.04 LTS):
#   sudo apt install flatpak flatpak-builder jq dpkg
#   flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
#   # On the host's own arch:
#   flatpak install --user flathub org.gnome.Platform//49 org.gnome.Sdk//49
#
# Output (where VERSION comes from package.json, ARCH from the host):
#   dist/flatpak-repo/                                  — the OSTree repo
#   dist/sensorium-${VERSION}-${ARCH}.flatpak           — single-file bundle
#   dist/sensorium.flatpakref                           — pointer for koher.app/sensorium/install

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not installed." >&2
  echo "Install with: sudo apt install jq" >&2
  exit 1
fi

VERSION="$(jq -r .version "${ROOT_DIR}/package.json")"
if [ -z "${VERSION}" ] || [ "${VERSION}" = "null" ]; then
  echo "ERROR: could not read version from package.json" >&2
  exit 1
fi

# Resolve target architecture. Precedence: positional arg > ARCH env var
# > host default. Host default is `dpkg --print-architecture`, which
# returns the Debian arch string ('amd64' / 'arm64') matching what
# `tauri build` emits in the .deb filename.
if [ -n "${1:-}" ]; then
  ARCH="$1"
elif [ -n "${ARCH:-}" ]; then
  : # use ARCH from env
elif command -v dpkg >/dev/null 2>&1; then
  ARCH="$(dpkg --print-architecture)"
else
  echo "ERROR: cannot determine target architecture." >&2
  echo "Install dpkg, set ARCH=amd64|arm64, or pass arch as the first arg." >&2
  exit 1
fi

case "${ARCH}" in
  amd64|arm64) ;;
  *)
    echo "ERROR: unsupported ARCH '${ARCH}'. Expected 'amd64' or 'arm64'." >&2
    exit 1
    ;;
esac

MANIFEST_TEMPLATE="${ROOT_DIR}/packaging/flatpak/app.koher.sensorium.yml"
# Render the manifest into the same directory as the template so relative
# `path:` references (e.g. `../../src-tauri/target/...`) resolve identically.
# The rendered file is gitignored.
MANIFEST_RENDERED="${ROOT_DIR}/packaging/flatpak/app.koher.sensorium.rendered.yml"
DEB="${ROOT_DIR}/src-tauri/target/release/bundle/deb/sensorium_${VERSION}_${ARCH}.deb"
DIST="${ROOT_DIR}/dist"
REPO="${DIST}/flatpak-repo"
BUILD_DIR="${DIST}/flatpak-build"
BUNDLE="${DIST}/sensorium-${VERSION}-${ARCH}.flatpak"
APP_ID="app.koher.sensorium"
BRANCH="stable"
BUILD_DATE="$(date -u +%Y-%m-%d)"

if [ ! -f "${DEB}" ]; then
  echo "ERROR: ${DEB} not found." >&2
  echo "Run 'npx tauri build --bundles deb' first to produce the ${ARCH} .deb." >&2
  exit 1
fi

if ! command -v flatpak-builder >/dev/null 2>&1; then
  echo "ERROR: flatpak-builder not installed." >&2
  echo "Install with: sudo apt install flatpak-builder" >&2
  exit 1
fi

mkdir -p "${DIST}"

echo "==> Rendering manifest for sensorium ${VERSION} on ${ARCH}"
sed \
  -e "s/__VERSION__/${VERSION}/g" \
  -e "s/__ARCH__/${ARCH}/g" \
  -e "s/__BUILD_DATE__/${BUILD_DATE}/g" \
  "${MANIFEST_TEMPLATE}" > "${MANIFEST_RENDERED}"

echo "==> Building flatpak from ${MANIFEST_RENDERED}"
flatpak-builder \
  --force-clean \
  --user \
  --install-deps-from=flathub \
  --repo="${REPO}" \
  --default-branch="${BRANCH}" \
  "${BUILD_DIR}" \
  "${MANIFEST_RENDERED}"

echo "==> Bundling single-file flatpak"
flatpak build-bundle "${REPO}" "${BUNDLE}" "${APP_ID}" "${BRANCH}"

echo "==> Writing .flatpakref pointer"
cat > "${DIST}/sensorium.flatpakref" <<EOF
[Flatpak Ref]
Title=Sensorium
Name=${APP_ID}
Branch=${BRANCH}
Url=https://koher.app/sensorium/flatpak
SuggestRemoteName=koher
IsRuntime=false
GPGKey=
RuntimeRepo=https://flathub.org/repo/flathub.flatpakrepo
EOF

echo
echo "✓ Flatpak built."
echo "  Bundle:    ${BUNDLE}"
echo "  Repo:      ${REPO}"
echo "  .flatpakref: ${DIST}/sensorium.flatpakref"
echo
echo "Local install test:"
echo "  flatpak install --user --bundle ${BUNDLE}"
echo "  flatpak run ${APP_ID}"
