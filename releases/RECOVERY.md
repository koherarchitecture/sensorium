# RECOVERY — stalled or interrupted build session

When a build session on a Linux host (or the Mac) was interrupted mid-flow, hung, or left ambiguous state behind, run this before re-attempting the build. Restores the working tree to a clean state aligned with `origin/main`, kills zombie build processes, drops local build caches, and re-asserts the per-host git author config.

Safe to run any time the host has no work-in-progress that hasn't been pushed (or that you don't mind losing). **Destructive** — wipes uncommitted changes and untracked build artefacts.

## The brief — paste into the Claude Code session on the affected host

```bash
cd ~/Dropbox/personal_projects/koher/tools-scratch/02-sensorium/sensorium

# 1. Kill zombie build processes if any survived from the last session.
pkill -f tauri 2>/dev/null
pkill -f flatpak-builder 2>/dev/null

# 2. Wipe local build state (gitignored; safe to lose).
rm -rf src-tauri/target/release dist .flatpak-builder

# 3. Realign with origin/main; discard any uncommitted local changes.
git fetch origin --force --prune
git reset --hard origin/main
git clean -fd

# 4. Re-assert the per-host git author config. Dropbox-synced .git/config
#    is unreliable across hosts — setting it explicitly per session is
#    cheap insurance against the next push going out as the wrong author.
git config user.name "Koher Architecture"
git config user.email "hello@koher.app"

# 5. Confirm the state is clean.
git status
git log -1 --format='%h %s | author: %an <%ae>'
```

## What to do after recovery

Open `releases/README.md` and follow it from **Step 2** for the matching host.

## Why each step exists

- **Step 1 (pkill).** Tauri's dev server, the Rust compiler, and `flatpak-builder` can each leave processes holding file locks (`.flatpak-builder/cache/.lock`, `dist/flatpak-repo/.lock`) that block the next attempt. `pkill -f` is broad on purpose — these processes shouldn't be running across sessions anyway.

- **Step 2 (rm -rf build state).** `src-tauri/target/release` carries the partial build output of the stalled run; `dist/` carries staging artefacts; `.flatpak-builder/` is the flatpak working directory. All gitignored, all local-only, all safely rebuildable. Note: `src-tauri/target/` (without `release/`) holds the dependency cache for incremental compilation — leaving it intact saves ~5–10 minutes on the next build. Wipe only `release/` inside it.

- **Step 3 (git reset --hard).** Discards any uncommitted edits and untracked files in the tracked tree. The amd64 build session on 8 May 2026 left three uncommitted pipeline edits (the flatpak-script genericity work) — these have since been committed from Mac (`4b6a0dc`) and are part of `origin/main`, so a hard reset on this host pulls them in correctly.

- **Step 4 (git config user).** Dropbox-syncing `.git/config` between hosts has been observed to reset the `[user]` section, causing commits to go out with the OS-default `username@hostname` instead of `Koher Architecture <hello@koher.app>`. Re-asserting per session is the workaround until the repo moves out of Dropbox (tracked in `tools-scratch/02-sensorium/buffer.md`).

- **Step 5 (verify).** `git status` should show a clean tree. `git log -1` confirms the most recent commit's author is what you expect (the just-asserted `Koher Architecture`, not yesterday's `Prayas Abhinav <…@Mac-mini.local>` slip).

## Related gotchas

- **Cross-platform `node_modules` trap.** After the recovery, `releases/README.md` Step 2 (`rm -rf node_modules package-lock.json && npm install`) is still required — Dropbox-synced `node_modules` carries the wrong platform's Tauri CLI native binding.
- **`.git/`-via-Dropbox object corruption.** If `git fetch` or `git status` reports `Could not read <sha>` errors, the `.git/objects/` folder is mid-sync and inconsistent. Re-run Step 3 after a minute (Dropbox should have caught up); persistent errors mean the local `.git/` is genuinely corrupt — back it up first (`mv .git .git.broken-<date>`), then `git clone git@github.com:koherarchitecture/sensorium.git ../sensorium-fresh` and copy the working tree across.
- **Auth gap on push.** If `git push` fails with `could not read Username for 'https://github.com'`, the host has no GitHub credentials configured. Two fixes are documented in `releases/README.md` (gh CLI or SSH key); for the in-flight v0.1.1 release, the workaround is to commit locally and let the orchestration host (Mac) push via Dropbox-synced `.git/`.
