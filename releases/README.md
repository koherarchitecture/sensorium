# releases/

Cross-host staging area for Sensorium build artefacts. Each platform-arch subfolder receives one or more output files; once all four legs are filled, the contents are attached to a GitHub Release.

This folder is committed to git (unlike `dist/` and `src-tauri/target/`, which are gitignored) so build outputs travel between Mac and Linux dev hosts via the repo, not via Dropbox alone. `.gitignore` excepts `releases/**/*.{dmg,deb,flatpak}` so the binaries are tracked.

---

## Current target

**Version:** `0.1.1` (hotfix). Engine bumped to 0.1.1 in `package.json`, `tauri.conf.json`, `src-tauri/Cargo.toml`. Sycophancy flavour version unchanged.

**Status (8 May 2026 evening):**

| Folder | Expected file(s) | State |
|---|---|---|
| `macos-aarch64/` | `sensorium_0.1.1_aarch64.dmg` | ✅ done (4.3 MB) |
| `macos-x64/` | `sensorium_0.1.1_x64.dmg` | ✅ done (4.6 MB) |
| `linux-amd64/` | `sensorium_0.1.1_amd64.deb` + `sensorium-0.1.1-amd64.flatpak` | ⏳ pending |
| `linux-arm64/` | `sensorium_0.1.1_arm64.deb` | ✅ done (4.4 MB, `2478b61e...5b7ebd4`) |

---

## For a Claude Code session on a Linux host

Read this section, identify the host, run the matching block, commit, push. No human round-trip required.

### Step 1 — identify the host

```bash
uname -s -m
```

- `Linux x86_64` → you are the **x86_64 Linux dev box**. Your job is to fill `linux-amd64/`.
- `Linux aarch64` → you are the **arm64 Linux host (Parallels VM or other)**. Your job is to fill `linux-arm64/`.
- Anything else → wrong host; stop.

### Step 2 — restore the Linux Tauri CLI native binding

Dropbox-synced `node_modules` carries platform-specific Tauri CLI native bindings. The Mac dev session most recently ran `npm install`, so `node_modules/@tauri-apps/cli-darwin-arm64` is present and the Linux variant isn't. Without this step the build fails with `Cannot find module '@tauri-apps/cli-linux-x64-gnu'` (or the arm64 variant).

```bash
cd ~/Dropbox/personal_projects/koher/tools-scratch/02-sensorium/sensorium
git pull --rebase
rm -rf node_modules package-lock.json
npm install
```

### Step 3 — build (x86_64 Linux dev box → `linux-amd64/`)

```bash
./node_modules/.bin/tauri build --bundles deb
bash scripts/build-flatpak.sh
cp src-tauri/target/release/bundle/deb/sensorium_0.1.1_amd64.deb releases/linux-amd64/
cp dist/sensorium-0.1.1-amd64.flatpak releases/linux-amd64/
shasum -a 256 releases/linux-amd64/sensorium_0.1.1_amd64.deb releases/linux-amd64/sensorium-0.1.1-amd64.flatpak
```

### Step 3 — build (arm64 Linux host → `linux-arm64/`)

```bash
./node_modules/.bin/tauri build --bundles deb
cp src-tauri/target/release/bundle/deb/sensorium_0.1.1_arm64.deb releases/linux-arm64/
shasum -a 256 releases/linux-arm64/sensorium_0.1.1_arm64.deb
```

### Step 4 — commit, then push if the host has GitHub auth

```bash
git add releases/
git commit -m "release(<arch>): sensorium 0.1.1 <artefact summary>"
git push
```

Replace `<arch>` with `linux-amd64` or `linux-arm64`. Replace `<artefact summary>` with `amd64 .deb + amd64 .flatpak` or `arm64 .deb`.

**Auth-gap caveat (arm64 Parallels VM, observed 8 May 2026):** the arm64 host has no GitHub credential helper and no SSH key registered with GitHub, so `git push` fails with `fatal: could not read Username for 'https://github.com'`. The local commit lands fine; **stop after the commit and report back**. The Mac side picks the commit up via Dropbox-synced `.git` and pushes from there.

If a future session on this host wants autonomous push, configure auth once: install `gh` and run `gh auth login`, or add an SSH key to GitHub and switch the remote with `git remote set-url origin git@github.com:koherarchitecture/sensorium.git`. The x86_64 Linux dev box did not exhibit this gap during the v0.1.0 build session (it had auth pre-configured), but verify with `git push --dry-run` before assuming.

### Step 5 — confirm in chat

Report back: SHA-256 of each artefact built, file sizes, build duration, any warnings worth noting.

---

## Gotchas

**Cross-platform `node_modules` trap.** Step 2 above is mandatory on every cross-host handoff. Skipping it surfaces as `Cannot find module '@tauri-apps/cli-<platform>-<arch>'`. The Mac in turn needs the same `rm -rf` + `npm install` after the Linux session pushes — but only when the Mac next builds.

**`cc` PATH-shadowing.** Specific to Mac and the Mac-side Parallels VM where `~/.local/bin/cc` is an interactive wrapper that shadows `/usr/bin/cc`. Symptom: build fails partway through linking with `cc requires an interactive terminal (TTY)`. Fix: prepend `PATH="/usr/bin:$PATH"` to the build command. The standalone x86_64 Linux dev box does NOT have this problem (no `~/.local/bin/cc` there) per the v0.1.0 build session.

**Flatpak host requirements.** The amd64 `.flatpak` build needs `flatpak` + `flatpak-builder` + the flathub user remote with `org.gnome.Platform//49` + `org.gnome.Sdk//49`. These were installed on the x86_64 Linux dev box during the v0.1.0 session and should still be present.

**Repo visibility.** `koherarchitecture` org defaults to private despite `gh repo create --public`. The sensorium repo is already public from the v0.1.0 release; no action needed for v0.1.1.

---

## After all four legs land (Mac orchestrates)

1. `shasum -a 256 releases/*/sensorium*` — final hash list.
2. Cut a GitHub Release `v0.1.1` on `koherarchitecture/sensorium` with release notes naming the three bug fixes (markdown rendering, label gutter, send-clear) plus the new-chat pill. Attach all five artefacts.
3. Update `koher.app/tools/sensorium` download links via `website-beta-v3/`. Per `website-beta-v3/CLAUDE.md`, copy-only edits to download links don't need a frontend-designer review; structural changes do.
4. Note the hotfix in passing in the still-pending v0.1.0 announcement post. No fresh announcement post for the patch.

---

## Layout (general — not specific to v0.1.1)

```
releases/
├── macos-aarch64/        — sensorium_<ver>_aarch64.dmg     (Apple Silicon)
├── macos-x64/            — sensorium_<ver>_x64.dmg         (Intel macOS)
├── linux-amd64/          — sensorium_<ver>_amd64.deb + sensorium-<ver>-amd64.flatpak
└── linux-arm64/          — sensorium_<ver>_arm64.deb
```

When a new release cycle begins (e.g. v0.1.2, v0.2.0), update the "Current target" table at the top of this README and the version numbers in the build blocks. The four-folder layout stays the same.
