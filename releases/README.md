# releases/

Cross-host staging area for Sensorium build artefacts. Each platform-arch subfolder receives one or more output files; once all four legs are filled, the contents are attached to a GitHub Release.

This folder is committed to git (unlike `dist/` and `src-tauri/target/`, which are gitignored) so build outputs travel between Mac and Linux dev hosts via the repo, not via Dropbox alone. `.gitignore` excepts `releases/**/*.{dmg,deb,flatpak}` so the binaries are tracked.

---

## Current target

**Version:** `0.1.1` shipped 9 May 2026 ([release](https://github.com/koherarchitecture/sensorium/releases/tag/v0.1.1)). Next: **v0.1.2** on the `v0.1.2` branch — adds arm64 flatpak parity. Bump engine to 0.1.2 in `package.json`, `tauri.conf.json`, `src-tauri/Cargo.toml` before building. Sycophancy flavour version unchanged.

**v0.1.1 status (shipped 9 May 2026):**

| Folder | File(s) | State |
|---|---|---|
| `macos-aarch64/` | `sensorium_0.1.1_aarch64.dmg` | ✅ done (4.3 MB, `1570b225...23e33a9`) |
| `macos-x64/` | `sensorium_0.1.1_x64.dmg` | ✅ done (4.6 MB, `5dfd46cb...aec37fd7`) |
| `linux-amd64/` | `sensorium_0.1.1_amd64.deb` + `sensorium-0.1.1-amd64.flatpak` | ✅ done (4.6 MB `60c508ac...67c4e6659` + 3.3 MB `cd3f014f...92cf8051`) |
| `linux-arm64/` | `sensorium_0.1.1_arm64.deb` | ✅ done (4.4 MB, `2478b61e...5b7ebd4`) |

**v0.1.2 matrix (in progress on `v0.1.2` branch, earliest cut 22 May 2026):**

| Folder | File(s) | State |
|---|---|---|
| `macos-aarch64/` | `sensorium_0.1.2_aarch64.dmg` | ⏳ pending |
| `macos-x64/` | `sensorium_0.1.2_x64.dmg` | ⏳ pending |
| `linux-amd64/` | `sensorium_0.1.2_amd64.deb` + `sensorium-0.1.2-amd64.flatpak` | ⏳ pending |
| `linux-arm64/` | `sensorium_0.1.2_arm64.deb` + `sensorium-0.1.2-arm64.flatpak` (NEW) | ⏳ pending |

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
bash scripts/build-flatpak.sh
cp src-tauri/target/release/bundle/deb/sensorium_0.1.1_arm64.deb releases/linux-arm64/
cp dist/sensorium-0.1.1-arm64.flatpak releases/linux-arm64/
shasum -a 256 releases/linux-arm64/sensorium_0.1.1_arm64.deb releases/linux-arm64/sensorium-0.1.1-arm64.flatpak
```

**One-time prereq for the arm64 host (do this once before the first arm64 flatpak build):** install the arm64 GNOME runtimes from flathub on the VM. `scripts/build-flatpak.sh` reads the host's Debian arch via `dpkg --print-architecture` and produces an arm64 flatpak automatically; the runtimes the build pulls have to be present for arm64.

```bash
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub org.gnome.Platform//49 org.gnome.Sdk//49
```

If the runtime install fails because flathub doesn't serve that arch on this VM, fall back to building only the .deb (skip the flatpak step) and report back so we can investigate whether to host the arm64 runtime ourselves.

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

**Dropbox-syncs-`.git/` corruption (observed 8 May 2026 on amd64 host).** The `.git/` folder is inside the Dropbox-synced tree, so its pack/loose object files sync between hosts piecemeal. A host can wake up with a working tree that disagrees with `.git/objects` (e.g. tracked files showing as "deleted" or `Could not read <sha>` errors during `git log`). Symptom on amd64 was both at once: `releases/linux-arm64/sensorium_0.1.1_arm64.deb` shown as deleted, and missing objects for the two most recent commits.

Recovery, before doing anything destructive:

```bash
git fetch origin --force --prune
git fsck 2>&1 | head -10                # see what's missing locally
git reset --hard origin/main            # align working tree to remote
git clean -fd                           # remove Dropbox sync cruft (untracked files only)
git status                              # expect a clean tree
```

This pulls any objects the local `.git/` is missing, then forces the working tree to match `origin/main`. The destructive flags (`--hard`, `-fd`) are safe **only if** the host has not yet committed work locally — if it has, push first, or stash, before resetting. If `git push` is auth-blocked on this host (see arm64 caveat below), the safe move is to *commit* (so the work is recorded), then ask the orchestration host (Mac) to push for you.

**Long-term fix:** `.git/` should not be Dropbox-synced. Two options exist; both are tracked as follow-up work in `tools-scratch/02-sensorium/sensorium/BUILD-STATUS.md` and not blocking v0.1.1:

1. Add a Dropbox selective-sync exclusion for `.git/` in this folder, and clone fresh on each host into a non-synced parallel location.
2. Restructure so each host has its own checkout of `koherarchitecture/sensorium` outside Dropbox, with the source files pulled via `git pull` rather than via Dropbox.

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
