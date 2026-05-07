# Smoke-Test Plan — Sensorium — Sycophancy v0.1

Pre-release verification on clean Ubuntu 24.04 LTS VMs (one per artefact).
Each test follows the same flow; pass criteria are explicit per item.

## Common prep (both VMs)

1. Fresh Ubuntu 24.04 LTS install. No prior Sensorium / Ollama / Tauri
   artefacts. `whoami` returns a real user, not root.
2. Install Ollama: `curl -fsSL https://ollama.com/install.sh | sh`
3. Pull the classifier model: `ollama pull qwen2.5:7b`
4. Verify Ollama is running: `curl -s http://localhost:11434/api/tags | jq .`
   Expect `qwen2.5:7b` in the models array.
5. Have a working OpenRouter API key ready (`sk-or-v1-...`).

---

## VM 1 — `.deb` install path

### Install
```
sudo apt install ./sensorium_0.1.0_amd64.deb
```

**Pass criteria**
- `dpkg` reports no missing dependencies (WebKitGTK 4.1 auto-pulled).
- `sensorium` binary on `$PATH` (or in `/usr/bin/`).
- "Sensorium" entry appears in the GNOME Activities menu / launcher.

### First-run wizard
Launch from Activities. The wizard appears (because no preferences.json on
disk, no API key in keychain).

**Walk through each step:**

1. **API key step.** Paste OpenRouter key. Click Save.
   - Pass: key is accepted; success indicator shown.
2. **Ollama step.** Wizard auto-detects Ollama at localhost:11434.
   - Pass: green "reachable" status; classifier model auto-selected
     (`qwen2.5:7b`).
3. **Model pick step.** Choose chat model (e.g. `anthropic/claude-sonnet-4.6`).
   - Pass: dropdown populates from OpenRouter.
4. **Calibration step.** Wizard runs first calibration.
   - Pass: 5 sycophancy axes complete in <60 s. No panic in stderr.
5. **Finish.** Click Done.
   - Pass: wizard closes; main UI visible. The Behind-the-Curtain block
     under the planted_falsehood row shows Q/R/L layers. Dial values
     reflect real response data (not the verdict-keyed defaults).

### Persistence verification (the load-bearing test)

1. Quit the app (close window or `Ctrl+Q`).
2. Verify `~/.config/koher.sensorium/preferences.json` exists with
   `"first_run_complete": true`.
3. Verify the API key is in libsecret:
   `secret-tool lookup service sensorium account openrouter` returns the key.
4. Verify the flavour was seeded:
   `cat ~/.config/koher.sensorium/flavours/sycophancy.json | jq .slug`
   returns `"sycophancy"`.
5. Relaunch the app from Activities.
   - **Pass: wizard does NOT show.** Main UI visible immediately.
   - Pass: API key is still in keychain (chat works without re-entry).

### Functional verification

1. Send 3 chat messages to the active model.
   - Pass: all three stream cleanly, replies render.
2. Open the panel; click Refresh on the flavour panel.
   - Pass: 5-axis calibration runs; verdicts populate; dial values change
     based on actual responses; Haiku narration appears in the Behaviour
     and Reading sections.
3. Click "Show full probe set" (panel footer).
   - Pass: modal lists 5 axes × 10 probes each, with the actual probe text and stylistic name per probe.
4. Open Settings; toggle a control (e.g. narration mode).
   - Pass: change persists across a quit + relaunch cycle (verify by
     reading `preferences.json` after quit).

### Linux-specific rendering

- `●◐○` symbols render correctly (no fallback boxes).
- Verdict pills (HOLDS / SOFTENS / FOLDS) carry colour.
- Five-dial cluster renders SVG rings + percentages.
- "Behind the curtain" toggle expands cleanly.

---

## VM 2 — `.flatpak` install path

### Install
```
flatpak install --user --bundle dist/sensorium-0.1.0.flatpak
```

If GNOME Platform 49 isn't already on the VM, the install will pull it
from Flathub. (~600 MB first time.)

**Pass criteria**
- `flatpak list --user` shows `app.koher.sensorium`.
- Sandbox permissions are minimal:
  ```
  flatpak info --show-permissions app.koher.sensorium
  ```
  expects: `--share=network --share=ipc --socket=wayland
  --socket=fallback-x11 --device=dri --talk-name=org.freedesktop.secrets`.
  No `--filesystem=home`.

### Launch
```
flatpak run app.koher.sensorium
```

Walk the **entire VM 1 flow** above. Additional sandbox-specific
checks:

1. **Config dir resolves under sandbox path.**
   ```
   ls -la ~/.var/app/app.koher.sensorium/config/koher.sensorium/
   ```
   Should contain `preferences.json` and `flavours/sycophancy.json`
   after first-run completes.
2. **Keyring access works.** API key persists across relaunch.
   Verify: `secret-tool lookup service sensorium account openrouter`
   from inside `flatpak run --command=bash app.koher.sensorium` returns
   the key.
3. **Ollama loopback reachable.** From inside the sandbox, `curl` to
   `localhost:11434` succeeds. (`--share=network` permits this.)
4. **OpenRouter HTTPS.** Calibration completes — confirms TLS chain
   resolution inside the sandbox.
5. **WebKitGTK rendering.** Filter symbols, chat bubbles, settings
   modal, first-run wizard render legibly. Minor pixel-level
   differences from native WebKit are acceptable; structural breakage
   is not.

---

## Negative-path checks (both VMs)

1. **Quit Ollama, relaunch.** App should boot; flavour panel should
   show "Ollama unavailable — running in degraded mode" banner.
   Calibration falls back to regex Q-layer.
2. **Bad API key.** Enter `sk-or-v1-XXXXXX` (clearly invalid). Wizard
   should refuse with a useful error; not crash.
3. **Cold-start with corrupt preferences.json.** `echo "{}" > ~/.config/koher.sensorium/preferences.json`
   then relaunch. App should boot with defaults; wizard should appear
   again. No panic.
4. **Cold-start with corrupt flavour file.** `echo "{}" > ~/.config/koher.sensorium/flavours/sycophancy.json`
   then relaunch. App should log a flavour-load error and re-seed from
   bundle on first wizard run. No panic.

---

## Release blockers (any failure here halts ship)

- Wizard appears on fresh install.
- Wizard does NOT appear on second launch after completion.
- API key persists across launches without re-entry.
- Flavour file ends up in user-data dir after wizard completes.
- 5-axis calibration produces real verdicts that round-trip through
  Haiku narration.
- Ollama loopback works from inside the flatpak sandbox.
- No `--filesystem=home` permission in flatpak.

## Non-blocking observations to log (not blockers)

- Visual rendering deltas between Apple WebKit and WebKitGTK — track
  in BUILD-STATUS, fix iteratively in v0.1.x.
- First-launch latency on flatpak (runtime cold-start).
- ARM64 / aarch64 not in v0.1 scope; defer to v0.1.x.

---

## Quick post-build sanity (no VM needed)

Run before shipping artefacts to anyone:

```bash
# .deb structure check
dpkg-deb -I src-tauri/target/release/bundle/deb/sensorium_0.1.0_amd64.deb
dpkg-deb -c src-tauri/target/release/bundle/deb/sensorium_0.1.0_amd64.deb | head -20

# .flatpak structure check
flatpak info --show-metadata app.koher.sensorium 2>/dev/null \
  || echo "(install --user --bundle first to inspect)"

# Bundle size sanity
ls -lh src-tauri/target/release/bundle/deb/*.deb dist/*.flatpak

# Confirm flavour JSON is in the .deb payload
dpkg-deb -c src-tauri/target/release/bundle/deb/sensorium_0.1.0_amd64.deb \
  | grep flavours
```

---

*Authored alongside the seventeenth–twentieth-pass build cycle on 7 May 2026.
Update when v0.1.x adds Windows packaging, Linux ARM, or new flavours.*
