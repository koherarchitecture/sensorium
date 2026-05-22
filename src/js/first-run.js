// first-run.js — multi-step first-run wizard.
//
// The wizard runs once on first launch and gates panel functionality
// until Settings::first_run_complete is true. v0.1 (sycophancy flavour)
// has three steps:
//
//   1. apikey      — OpenRouter API key entry → set_api_key
//   2. ollama      — system info, recommended model, daemon detection
//   3. calibrate   — first calibration; hands off the populated
//                    Fingerprint to filter-panel.js
//
// What the engine probes is determined by the active flavour
// (flavours/<slug>.json), not by per-class opt-in here. Sycophancy is
// the only v0.1 flavour and it ships its own probe bank.
//
// In Tauri runtime each step persists via IPC. In browser preview
// (no __TAURI__), the wizard still works for design inspection but
// uses localStorage and synthetic Ollama/calibration outputs so the
// flow can be walked end-to-end.
//
// The replay link in the panel footer reopens the wizard at the
// "calibrate" step — re-running calibration is a separate concern
// also exposed via the panel's "refresh" affordance.

import { isTauri, NotInTauri, ApiKey, SystemSetup, Ollama, Settings, Calibration } from './ipc.js';

const FR_KEY = 'koher.sensorium.firstRunComplete';

const STEPS = ['apikey', 'ollama', 'calibrate'];

let _state = {
  step: 'apikey',
  apiKeySet: false,
  ollamaReady: false,
  fingerprint: null,
};

let _onComplete = null;

// ── Public surface ──────────────────────────────────────────────────

export async function init({ onComplete } = {}) {
  _onComplete = onComplete || null;

  await wireUI();
  await decideInitialVisibility();
}

export function show(step) {
  document.body.setAttribute('data-first-run', 'true');
  goToStep(step || 'apikey');
}

export function hide() {
  document.body.setAttribute('data-first-run', 'false');
}

// ── Step navigation ─────────────────────────────────────────────────

function goToStep(step) {
  _state.step = step;
  const card = document.querySelector('.first-run-card');
  if (card) card.setAttribute('data-step', step);

  // Step indicator dots
  document.querySelectorAll('.fr-step-dot').forEach((dot) => {
    const dotStep = dot.getAttribute('data-step');
    const idxCurrent = STEPS.indexOf(step);
    const idxDot = STEPS.indexOf(dotStep);
    dot.setAttribute('data-state',
      idxDot < idxCurrent ? 'done' :
      idxDot === idxCurrent ? 'current' : 'pending');
  });

  // Step-specific entry hooks
  if (step === 'ollama') refreshOllamaPanel();
  if (step === 'calibrate') runCalibrationStep();
}

// ── Step 1: API key ─────────────────────────────────────────────────

function wireApiKeyStep() {
  const submit = document.getElementById('fr-apikey-submit');
  const input = document.getElementById('fr-apikey-input');
  const status = document.getElementById('fr-apikey-status');

  if (!submit || !input) return;

  submit.addEventListener('click', async () => {
    const key = (input.value || '').trim();
    if (!key) {
      status.textContent = 'Paste your OpenRouter API key.';
      status.setAttribute('data-state', 'warn');
      return;
    }
    status.textContent = 'Saving to system keychain…';
    status.setAttribute('data-state', 'pending');
    submit.disabled = true;

    try {
      if (isTauri) {
        await ApiKey.set(key);
      } else {
        // Preview: pretend it worked.
        await new Promise((r) => setTimeout(r, 200));
      }
      _state.apiKeySet = true;
      status.textContent = 'Key stored. Continuing…';
      status.setAttribute('data-state', 'ok');
      setTimeout(() => goToStep('ollama'), 250);
    } catch (err) {
      status.textContent = (err && err.message) ? err.message : String(err);
      status.setAttribute('data-state', 'warn');
    } finally {
      submit.disabled = false;
    }
  });
}

// ── Step 2: Ollama detection ────────────────────────────────────────

async function refreshOllamaPanel() {
  const ramEl = document.getElementById('fr-ollama-ram');
  const recEl = document.getElementById('fr-ollama-recommend');
  const cmdEl = document.getElementById('fr-ollama-pull-cmd');
  const statusEl = document.getElementById('fr-ollama-status');
  const continueBtn = document.getElementById('fr-ollama-continue');

  // Defaults (browser preview). Field names match Rust serde shape:
  //   SystemInfo: total_ram_gb, available_ram_gb, physical_cores, os_name, os_version
  //   OllamaRecommendation: tag, display_name, resident_size_gb, tier, rationale
  //   OllamaStatus: reachable, default_model_present, installed_models, recommended_model, error
  let ramGb = null;
  let recommend = { tag: 'qwen2.5:1.5b', display_name: 'Qwen 2.5 — 1.5B', tier: 'lean' };
  let status = { reachable: false, default_model_present: false };

  if (isTauri) {
    try {
      const info = await SystemSetup.systemInfo();
      ramGb = info && info.total_ram_gb;
    } catch (_) { /* ignore */ }
    try {
      recommend = await SystemSetup.recommendOllamaModel();
    } catch (_) { /* ignore */ }

    // Sync settings.ollama_model to the recommendation if they differ.
    // Settings defaults to qwen2.5:1.5b, but the recommendation depends
    // on system RAM — a fresh user with 16+ GB will get qwen2.5:3b
    // recommended. Ollama.status() asks "is settings.ollama_model
    // present?", so the two must agree before we poll, otherwise a
    // freshly-pulled recommended model reads as not-present.
    try {
      const s = await Settings.get();
      if (recommend && recommend.tag && s.ollama_model !== recommend.tag) {
        s.ollama_model = recommend.tag;
        await Settings.update(s);
      }
    } catch (_) { /* non-fatal */ }

    try {
      status = await Ollama.status();
    } catch (_) { /* ignore */ }
  }

  if (ramEl) ramEl.textContent = (ramGb != null) ? `${ramGb.toFixed(1)} GB` : '—';
  if (recEl) recEl.innerHTML = `<strong>${recommend.tag}</strong> <span class="fr-dim">(${recommend.tier})</span>`;
  if (cmdEl) cmdEl.textContent = `ollama pull ${recommend.tag}`;

  if (statusEl) {
    if (status.reachable && status.default_model_present) {
      statusEl.textContent = 'Ollama running, model present.';
      statusEl.setAttribute('data-state', 'ok');
      _state.ollamaReady = true;
    } else if (status.reachable && !status.default_model_present) {
      statusEl.textContent = 'Ollama running. Pull the recommended model with the command above, then click Continue.';
      statusEl.setAttribute('data-state', 'pending');
      _state.ollamaReady = false;
    } else if (!isTauri) {
      statusEl.textContent = '(preview) Ollama detection runs at desktop runtime.';
      statusEl.setAttribute('data-state', 'pending');
      _state.ollamaReady = true;
    } else {
      statusEl.textContent = 'Ollama daemon not detected. Start it with `ollama serve` (or open the Ollama app).';
      statusEl.setAttribute('data-state', 'warn');
      _state.ollamaReady = false;
    }
  }

  if (continueBtn) {
    continueBtn.disabled = !_state.ollamaReady;
  }
}

function wireOllamaStep() {
  const recheck = document.getElementById('fr-ollama-recheck');
  const continueBtn = document.getElementById('fr-ollama-continue');
  const skip = document.getElementById('fr-ollama-skip');
  const pullBtn = document.getElementById('fr-ollama-pull');

  if (recheck) recheck.addEventListener('click', async () => {
    // Visible loading state — Dhyeya #04: button used to silently re-run
    // the panel refresh, looked dead. Now it disables itself and shows
    // a status line while the async work happens, then restores.
    const statusEl = document.getElementById('fr-ollama-status');
    const originalLabel = recheck.textContent;
    recheck.disabled = true;
    recheck.textContent = 'Re-checking…';
    if (statusEl) {
      statusEl.textContent = 'Re-checking Ollama…';
      statusEl.setAttribute('data-state', 'pending');
    }
    try {
      await refreshOllamaPanel();
    } finally {
      recheck.disabled = false;
      recheck.textContent = originalLabel;
    }
  });
  if (continueBtn) continueBtn.addEventListener('click', () => goToStep('calibrate'));
  if (skip) skip.addEventListener('click', () => {
    // Lets users proceed even when daemon isn't running yet — they can
    // start Ollama later. The Q-layer will degrade until it is running.
    _state.ollamaReady = false;
    goToStep('calibrate');
  });
  if (pullBtn) pullBtn.addEventListener('click', startPull);
}

// ── In-app pull (streams progress from /api/pull) ─────────────────

let _pullUnlisten = null;

async function startPull() {
  console.log('[pull] startPull called');

  const cmdEl = document.getElementById('fr-ollama-pull-cmd');
  const progress = document.getElementById('fr-pull-progress');
  const fill = document.getElementById('fr-pull-bar-fill');
  const line = document.getElementById('fr-pull-line');
  const pullBtn = document.getElementById('fr-ollama-pull');
  const recheck = document.getElementById('fr-ollama-recheck');

  // Recover model tag from the rendered command — refreshOllamaPanel
  // wrote `ollama pull <tag>` here, so the last whitespace-separated
  // token is the tag.
  const cmd = (cmdEl && cmdEl.textContent) ? cmdEl.textContent.trim() : '';
  const model = cmd.split(/\s+/).pop();
  console.log('[pull] resolved model:', model);

  if (!model || model === 'undefined') {
    if (line) line.textContent = 'No model recommendation available — click Re-check first.';
    if (progress) progress.setAttribute('data-state', 'error');
    return;
  }

  if (!isTauri) {
    if (line) line.textContent = '(preview) In-app pull runs at desktop runtime.';
    if (progress) progress.setAttribute('data-state', 'done');
    return;
  }

  if (progress) progress.setAttribute('data-state', 'active');
  if (fill) fill.style.width = '0%';
  if (line) line.textContent = `Starting pull of ${model}…`;
  if (pullBtn) pullBtn.disabled = true;
  if (recheck) recheck.disabled = true;

  // One try/catch around the whole pipeline. If subscribing to events
  // fails for any reason (Tauri global shape, registration error,
  // anything), we still kick off the pull so Rust logs surface what's
  // happening — and the user gets a clear error in the wizard.
  try {
    if (_pullUnlisten) { try { _pullUnlisten(); } catch (_) {} _pullUnlisten = null; }

    console.log('[pull] subscribing to ollama-pull-progress');
    try {
      _pullUnlisten = await Ollama.onPullProgress(({ payload }) => {
        console.log('[pull] progress event:', payload);
        if (!payload) return;
        const { status, total, completed, error } = payload;

        if (error) {
          if (line) line.textContent = `Error: ${error}`;
          if (progress) progress.setAttribute('data-state', 'error');
          return;
        }

        if (typeof total === 'number' && typeof completed === 'number' && total > 0) {
          const pct = Math.max(0, Math.min(100, (completed / total) * 100));
          if (fill) fill.style.width = `${pct.toFixed(1)}%`;
          const mb = (n) => (n / (1024 * 1024)).toFixed(0);
          if (line) line.textContent = `${status || 'downloading'} · ${mb(completed)} / ${mb(total)} MB · ${pct.toFixed(0)}%`;
        } else if (status) {
          if (line) line.textContent = status;
        }
      });
      console.log('[pull] subscribed; unlisten ready');
    } catch (subErr) {
      console.warn('[pull] subscribe failed; continuing without live progress:', subErr);
      if (line) line.textContent = `Pulling ${model}… (no live progress — see terminal)`;
    }

    console.log('[pull] invoking ollama_pull');
    await Ollama.pull(model);
    console.log('[pull] ollama_pull resolved');

    if (fill) fill.style.width = '100%';
    if (line) line.textContent = `Pulled ${model}.`;
    if (progress) progress.setAttribute('data-state', 'done');

    // The wizard recommends a model based on RAM, but Settings::ollama_model
    // defaults to `qwen2.5:1.5b`. After a successful pull we update settings
    // to point at the model the user actually has — otherwise the status
    // re-poll asks "is settings.ollama_model present?" which is false.
    try {
      const s = await Settings.get();
      if (s.ollama_model !== model) {
        s.ollama_model = model;
        s.ollama_setup_complete = true;
        await Settings.update(s);
        console.log('[pull] settings.ollama_model updated to', model);
      }
    } catch (settingsErr) {
      console.warn('[pull] could not update settings.ollama_model:', settingsErr);
    }

    // Re-poll status so the Continue button enables.
    await refreshOllamaPanel();
  } catch (err) {
    console.error('[pull] failed:', err);
    const msg = (err && err.message) ? err.message : String(err);
    if (line) line.textContent = `Pull failed: ${msg}`;
    if (progress) progress.setAttribute('data-state', 'error');
  } finally {
    if (pullBtn) pullBtn.disabled = false;
    if (recheck) recheck.disabled = false;
    if (_pullUnlisten) { try { _pullUnlisten(); } catch (_) {} _pullUnlisten = null; }
  }
}

// ── Step 3: First calibration ───────────────────────────────────────

async function runCalibrationStep() {
  const status = document.getElementById('fr-calibrate-status');
  const finish = document.getElementById('fr-calibrate-finish');
  const retry = document.getElementById('fr-calibrate-retry');

  if (status) {
    status.textContent = 'Running first calibration…';
    status.setAttribute('data-state', 'pending');
  }
  if (finish) finish.disabled = true;
  if (retry) retry.style.display = 'none';

  try {
    if (isTauri) {
      // Seed the bundled flavour config into user-data BEFORE the run.
      // Installed builds (.deb / .flatpak / .dmg) have no working-dir
      // `flavours/` folder, so the engine returns "no flavour loaded"
      // unless this seed has already happened. (Previously seeding ran
      // only inside the FINISH handler — which made the first calibration
      // always fail.)
      try {
        await window.__TAURI__.core.invoke('seed_active_flavour');
      } catch (e) {
        console.warn('flavour seed before calibration failed:', e);
      }
      const fp = await Calibration.run();
      _state.fingerprint = fp;
    } else {
      await new Promise((r) => setTimeout(r, 600));
      _state.fingerprint = null; // preview leaves the static panel content
    }
    if (status) {
      status.textContent = 'Calibration complete.';
      status.setAttribute('data-state', 'ok');
    }
    if (finish) finish.disabled = false;
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    if (status) {
      status.textContent = `Calibration failed: ${msg}`;
      status.setAttribute('data-state', 'warn');
    }
    if (retry) retry.style.display = '';
    if (finish) finish.disabled = false; // allow finish-without-calibration; panel will show empty state
  }
}

function wireCalibrateStep() {
  const finish = document.getElementById('fr-calibrate-finish');
  const retry = document.getElementById('fr-calibrate-retry');

  if (retry) retry.addEventListener('click', runCalibrationStep);

  if (finish) finish.addEventListener('click', async () => {
    // Mark first-run complete in both stores.
    try {
      const existing = JSON.parse(localStorage.getItem(FR_KEY) || '{}');
      existing.completed = true;
      existing.completedAt = new Date().toISOString();
      localStorage.setItem(FR_KEY, JSON.stringify(existing));
    } catch (_) {}

    if (isTauri) {
      try {
        // Seed the bundled flavour config into the user-data dir so the
        // engine can find it on installed builds (.deb / .flatpak / .dmg)
        // where no working-directory `flavours/` folder exists.
        await window.__TAURI__.core.invoke('seed_active_flavour');
      } catch (e) {
        console.warn('flavour seed failed:', e);
      }
      try {
        const s = await Settings.get();
        s.first_run_complete = true;
        s.ollama_setup_complete = true;
        await Settings.update(s);
      } catch (_) {}
    }

    hide();
    if (_onComplete) _onComplete({
      fingerprint: _state.fingerprint,
    });
  });
}

// ── Initial visibility decision ─────────────────────────────────────

async function decideInitialVisibility() {
  let alreadyComplete = false;

  if (isTauri) {
    try {
      const s = await Settings.get();
      alreadyComplete = !!s.first_run_complete;
    } catch (_) { /* fall through to localStorage */ }
  }

  if (!alreadyComplete) {
    try {
      const saved = JSON.parse(localStorage.getItem(FR_KEY) || 'null');
      alreadyComplete = !!(saved && saved.completed);
    } catch (_) {}
  }

  if (alreadyComplete) {
    hide();
  } else {
    show('apikey');
  }
}

async function wireUI() {
  wireApiKeyStep();
  wireOllamaStep();
  wireCalibrateStep();

  const replay = document.getElementById('replay-first-run');
  if (replay) {
    replay.addEventListener('click', () => show('calibrate'));
  }
}
