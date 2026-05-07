#!/usr/bin/env bash
# Build the self-hosted flatpak from the most recent .deb produced by
# `npx tauri build --bundles deb`.
#
# Prereqs (Ubuntu 24.04 LTS):
#   sudo apt install flatpak flatpak-builder
#   flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
#   flatpak install --user flathub org.gnome.Platform//46 org.gnome.Sdk//46
#
# Output:
#   dist/flatpak-repo/                 — the OSTree repo
#   dist/sensorium-0.1.0.flatpak — single-file bundle
#   dist/sensorium.flatpakref    — pointer for koher.app/sensorium/install

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

MANIFEST="${ROOT_DIR}/packaging/flatpak/app.koher.sensorium.yml"
DEB="${ROOT_DIR}/src-tauri/target/release/bundle/deb/sensorium_0.1.0_amd64.deb"
DIST="${ROOT_DIR}/dist"
REPO="${DIST}/flatpak-repo"
BUILD_DIR="${DIST}/flatpak-build"
BUNDLE="${DIST}/sensorium-0.1.0.flatpak"
APP_ID="app.koher.sensorium"
BRANCH="stable"

if [ ! -f "${DEB}" ]; then
  echo "ERROR: ${DEB} not found." >&2
  echo "Run 'npm run build:linux-deb' first to produce the .deb." >&2
  exit 1
fi

if ! command -v flatpak-builder >/dev/null 2>&1; then
  echo "ERROR: flatpak-builder not installed." >&2
  echo "Install with: sudo apt install flatpak-builder" >&2
  exit 1
fi

mkdir -p "${DIST}"

echo "==> Building flatpak from ${MANIFEST}"
flatpak-builder \
  --force-clean \
  --user \
  --install-deps-from=flathub \
  --repo="${REPO}" \
  --default-branch="${BRANCH}" \
  "${BUILD_DIR}" \
  "${MANIFEST}"

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
