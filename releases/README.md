# releases/

Cross-host staging area for built artefacts. Each release version uses one platform-arch subfolder per artefact. When the matrix is complete, the contents are attached to the corresponding GitHub Release.

This folder is committed to git (unlike `dist/` and `src-tauri/target/`, which are gitignored) so build artefacts produced on different hosts can travel between machines via the repo, not via Dropbox alone.

## Layout

```
releases/
├── macos-aarch64/        — sensorium_<ver>_aarch64.dmg     (Apple Silicon)
├── macos-x64/            — sensorium_<ver>_x64.dmg         (Intel macOS)
├── linux-amd64/          — sensorium_<ver>_amd64.deb + sensorium-<ver>-amd64.flatpak
└── linux-arm64/          — sensorium_<ver>_arm64.deb
```

## Build commands by host

**Mac** (this folder is the source of truth for both macOS .dmgs):

```bash
cd ~/Dropbox/personal_projects/koher/tools-scratch/02-sensorium/sensorium
PATH="/usr/bin:$PATH" npm run build:mac-arm
PATH="/usr/bin:$PATH" npm run build:mac-intel
cp src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/sensorium_*_aarch64.dmg releases/macos-aarch64/
cp src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/sensorium_*_x64.dmg releases/macos-x64/
```

**x86_64 Linux dev box** — fills `linux-amd64/`:

```bash
cd ~/Dropbox/personal_projects/koher/tools-scratch/02-sensorium/sensorium
rm -rf node_modules package-lock.json && npm install
./node_modules/.bin/tauri build --bundles deb
bash scripts/build-flatpak.sh
cp src-tauri/target/release/bundle/deb/sensorium_*_amd64.deb releases/linux-amd64/
cp dist/sensorium-*-amd64.flatpak releases/linux-amd64/
```

**Parallels VM (arm64 Linux)** — fills `linux-arm64/`:

```bash
cd ~/Dropbox/personal_projects/koher/tools-scratch/02-sensorium/sensorium
rm -rf node_modules package-lock.json && npm install
./node_modules/.bin/tauri build --bundles deb
cp src-tauri/target/release/bundle/deb/sensorium_*_arm64.deb releases/linux-arm64/
```

After each host finishes its leg, `git add releases/<folder>/<artefact> && git commit -m "release(<arch>): <version>" && git push` so the next host can pull.

## Cross-platform `node_modules` trap

Dropbox-synced `node_modules` carries platform-specific Tauri CLI bindings. Each Linux host must `rm -rf node_modules package-lock.json && npm install` before building so its native binding loads. Skipping this surfaces as `Cannot find module '@tauri-apps/cli-darwin-arm64'` (or the Linux variant in reverse).

## `cc` PATH-shadowing gotcha (Mac + Mac-side VM)

If a build fails with `cc requires an interactive terminal`, prepend `PATH="/usr/bin:$PATH"` to the build command. Specific to hosts where `~/.local/bin/cc` is an interactive wrapper that shadows `/usr/bin/cc`. The standalone Linux dev box doesn't need this.

## After all four legs land

1. `shasum -a 256 releases/*/sensorium*` — verify the artefacts.
2. Cut a GitHub Release on `koherarchitecture/sensorium` for the version tag (`v<version>`); attach all five files (two .dmgs, two .debs, one .flatpak).
3. Update `koher.app/tools/sensorium` download links.
