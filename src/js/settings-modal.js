// settings-modal.js — settings overlay.
//
// In v0.1 this wires:
//   - Active-flavour read-only display.
//   - Probe selection per axis (Random / specific named probe), persisted
//     to Settings.probe_selection via Settings.update.
//   - API-key clear via ApiKey.clear.
// Other sections (Ollama, narration, workflow, about) render and are
// focusable but don't yet persist their values.

import { isTauri, Settings, ApiKey, Probes, Provider, FlavourInstall, External } from './ipc.js';
import { setTargetSplitHeld, formatRatio, directionTag, clampHeld } from './target-ratio.js';

let _onChanged = null;

export function init({ onChanged } = {}) {
  _onChanged = onChanged || null;

  const modal = document.getElementById('settings-modal');
  const btn = document.getElementById('settings-btn');
  const closeBtn = document.getElementById('settings-close');
  const cancel = document.getElementById('settings-cancel');
  const save = document.getElementById('settings-save');
  const backdrop = document.getElementById('settings-backdrop');

  if (!modal || !btn) return;

  const open = async () => {
    await syncFromSource();
    modal.setAttribute('data-open', 'true');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  };
  const close = () => {
    modal.setAttribute('data-open', 'false');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  btn.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (cancel) cancel.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);

  if (save) save.addEventListener('click', async () => {
    const probeSelection = readProbePickers();
    const activeModel = readChatModel();
    const extras = readExtraSettings();
    const targetHeld = readTargetSplitHeld();

    if (isTauri) {
      try {
        const s = await Settings.get();
        s.probe_selection = probeSelection;
        if (activeModel) s.active_model = activeModel;
        // Dhyeya #14: previously only probe_selection + active_model
        // were saved. The other dropdowns rendered but reverted on
        // relaunch. v0.1.6 wires Ollama model, refresh cadence,
        // budget cap, and narration mode to actual persistence.
        if (extras.ollama_model != null) s.ollama_model = extras.ollama_model;
        if (extras.refresh_hours != null) s.filter_cartography_refresh_hours = extras.refresh_hours;
        if (extras.budget_usd != null) s.filter_cartography_budget_usd = extras.budget_usd;
        if (extras.narration_mode != null) s.narration_mode = extras.narration_mode;
        // v0.1.7 — target ratio (canon rule 5: never call it "your split ratio").
        if (targetHeld != null) s.target_split_held = targetHeld;
        await Settings.update(s);
      } catch (err) {
        console.warn('settings save failed:', err);
      }
    } else if (targetHeld != null) {
      // Browser preview: at least keep the localStorage mirror in sync.
      try { await setTargetSplitHeld(targetHeld); } catch (_) {}
    }

    if (_onChanged) _onChanged({ probeSelection, activeModel, targetHeld });
    close();
  });

  // ── Provider section: update / clear API key ────────────────────
  wireProviderKeyActions();

  // ── Flavour install buttons (v0.1.6) ────────────────────────────
  // Three pathways — From URL, From file, Browse registry — each
  // calling its corresponding IPC. The v0.1.3 inline-notice placeholder
  // is gone; these are now real installs that fetch / read / validate
  // JSON, save to user-data/flavours/, set Settings.active_flavour to
  // the installed slug, and reload state.flavour so the next calibration
  // uses the new probe bank.
  wireFlavourInstallActions();

  // ── Target ratio control (v0.1.7) ───────────────────────────────
  // Live-updates the readout as the user drags; persistence happens
  // in the Save handler so a cancel discards changes consistently with
  // the rest of the modal.
  wireTargetRatioControl();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.getAttribute('data-open') === 'true') close();
  });
}

// ── Provider key actions (Update / Clear) ───────────────────────────
//
// The Update button opens an inline entry row below the API-key row;
// Save calls ApiKey.set() and on success flips the status pill to
// "● Set". Clear asks the user to confirm, then ApiKey.clear() and
// flips the pill to "○ Not set". Both surface errors inline rather
// than silently swallowing them — the v0.1.4 bug was a silent catch
// on Clear plus no Update handler at all.

function setKeyStatusPill(present) {
  const pill = document.getElementById('settings-key-status');
  if (!pill) return;
  if (present) {
    pill.textContent = '● Set';
    pill.classList.remove('warn');
    pill.classList.add('ok');
  } else {
    pill.textContent = '○ Not set';
    pill.classList.remove('ok');
    pill.classList.add('warn');
  }
}

async function refreshKeyStatusPill() {
  if (!isTauri) return;
  try {
    const present = await ApiKey.has();
    setKeyStatusPill(Boolean(present));
  } catch (err) {
    console.warn('ApiKey.has failed:', err);
  }
}

function showKeyEntryStatus(text, state) {
  const el = document.getElementById('settings-key-entry-status');
  if (!el) return;
  if (!text) {
    el.textContent = '';
    el.hidden = true;
    el.classList.remove('ok', 'warn');
    return;
  }
  el.textContent = text;
  el.hidden = false;
  el.classList.remove('ok', 'warn');
  if (state === 'ok') el.classList.add('ok');
  else if (state === 'warn') el.classList.add('warn');
}

function openKeyEntry() {
  const row = document.getElementById('settings-key-entry-row');
  const input = document.getElementById('settings-key-input');
  if (!row) return;
  row.hidden = false;
  showKeyEntryStatus('', null);
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 0);
  }
}

function closeKeyEntry() {
  const row = document.getElementById('settings-key-entry-row');
  const input = document.getElementById('settings-key-input');
  if (!row) return;
  row.hidden = true;
  if (input) input.value = '';
  showKeyEntryStatus('', null);
}

async function saveNewKey() {
  const input = document.getElementById('settings-key-input');
  const saveBtn = document.getElementById('settings-key-save');
  const key = (input && input.value || '').trim();
  if (!key) {
    showKeyEntryStatus('Paste your OpenRouter API key.', 'warn');
    return;
  }
  if (!isTauri) {
    closeKeyEntry();
    return;
  }
  showKeyEntryStatus('Saving to system keychain…', null);
  if (saveBtn) saveBtn.disabled = true;
  try {
    await ApiKey.set(key);
    setKeyStatusPill(true);
    showKeyEntryStatus('Key saved.', 'ok');
    setTimeout(closeKeyEntry, 600);
  } catch (err) {
    showKeyEntryStatus((err && err.message) ? err.message : String(err), 'warn');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function clearKey() {
  if (!isTauri) return;
  const ok = window.confirm('Remove the saved OpenRouter API key from the system keychain?');
  if (!ok) return;
  const clearBtn = document.getElementById('settings-clear-key');
  if (clearBtn) clearBtn.disabled = true;
  try {
    await ApiKey.clear();
    setKeyStatusPill(false);
    closeKeyEntry();
  } catch (err) {
    console.warn('ApiKey.clear failed:', err);
    window.alert('Could not clear API key: ' + ((err && err.message) ? err.message : String(err)));
  } finally {
    if (clearBtn) clearBtn.disabled = false;
  }
}

// ── Flavour install (v0.1.6) ────────────────────────────────────────
//
// Three install pathways. Status surfaces in a single inline span below
// the install-buttons row; cleared on next modal-open via syncFromSource.

const FLAVOUR_REGISTRY_URL = 'https://koher.app/tools/sensorium/flavours';
const FLAVOUR_SAMPLE_URL =
  'https://raw.githubusercontent.com/koherarchitecture/sensorium/main/flavours/sycophancy.json';

function showFlavourInstallStatus(text, state) {
  const installUrlBtn = document.getElementById('settings-flavour-install-url');
  const installFileBtn = document.getElementById('settings-flavour-install-file');
  const browseBtn = document.getElementById('settings-flavour-browse');
  const anchor = installUrlBtn || installFileBtn || browseBtn;
  if (!anchor) return;
  let notice = anchor.parentElement.parentElement
    .querySelector('.flavour-install-status');
  if (!notice) {
    notice = document.createElement('span');
    notice.className = 'label-sub flavour-install-status';
    notice.style.display = 'block';
    notice.style.marginTop = '8px';
    anchor.parentElement.parentElement.appendChild(notice);
  }
  if (!text) {
    notice.textContent = '';
    notice.style.display = 'none';
    notice.removeAttribute('data-state');
    return;
  }
  notice.style.display = 'block';
  notice.textContent = text;
  notice.style.color = state === 'warn'
    ? 'var(--hue-refusal, #b04a3e)'
    : state === 'ok'
      ? 'var(--hue-substantive, #3d7a4a)'
      : 'var(--ink-paper-3, #6e6258)';
  if (state) notice.setAttribute('data-state', state);
  else notice.removeAttribute('data-state');
}

async function handleFromUrl() {
  const url = window.prompt(
    'Paste the URL of a flavour JSON file (must start with http:// or https://):',
    FLAVOUR_SAMPLE_URL
  );
  if (url === null) return;  // user cancelled
  const trimmed = url.trim();
  if (!trimmed) {
    showFlavourInstallStatus('URL is empty.', 'warn');
    return;
  }
  if (!isTauri) {
    showFlavourInstallStatus('From URL runs only inside the desktop app.', 'warn');
    return;
  }
  showFlavourInstallStatus('Fetching and validating…', null);
  try {
    const slug = await FlavourInstall.fromUrl(trimmed);
    showFlavourInstallStatus(
      `Installed and activated '${slug}'. Run a calibration to use it.`,
      'ok'
    );
  } catch (err) {
    showFlavourInstallStatus(
      'Install failed: ' + ((err && err.message) ? err.message : String(err)),
      'warn'
    );
  }
}

async function handleFromFile() {
  if (!isTauri) {
    showFlavourInstallStatus('From file runs only inside the desktop app.', 'warn');
    return;
  }
  showFlavourInstallStatus('Choose a flavour JSON file…', null);
  try {
    const slug = await FlavourInstall.fromFile();
    if (slug === null) {
      showFlavourInstallStatus('', null);  // cancelled
      return;
    }
    showFlavourInstallStatus(
      `Installed and activated '${slug}'. Run a calibration to use it.`,
      'ok'
    );
  } catch (err) {
    showFlavourInstallStatus(
      'Install failed: ' + ((err && err.message) ? err.message : String(err)),
      'warn'
    );
  }
}

async function handleBrowseRegistry() {
  if (!isTauri) {
    showFlavourInstallStatus(
      'Browse registry runs only inside the desktop app. URL: ' + FLAVOUR_REGISTRY_URL,
      null
    );
    return;
  }
  try {
    await External.openUrl(FLAVOUR_REGISTRY_URL);
    showFlavourInstallStatus('Opened registry in your default browser.', 'ok');
  } catch (err) {
    showFlavourInstallStatus(
      'Could not open browser: ' + ((err && err.message) ? err.message : String(err)) +
        '. URL: ' + FLAVOUR_REGISTRY_URL,
      'warn'
    );
  }
}

function wireFlavourInstallActions() {
  const installUrlBtn = document.getElementById('settings-flavour-install-url');
  const installFileBtn = document.getElementById('settings-flavour-install-file');
  const browseBtn = document.getElementById('settings-flavour-browse');
  if (installUrlBtn) installUrlBtn.addEventListener('click', handleFromUrl);
  if (installFileBtn) installFileBtn.addEventListener('click', handleFromFile);
  if (browseBtn) browseBtn.addEventListener('click', handleBrowseRegistry);
}

function wireProviderKeyActions() {
  const update = document.getElementById('settings-update-key');
  const clear = document.getElementById('settings-clear-key');
  const save = document.getElementById('settings-key-save');
  const cancel = document.getElementById('settings-key-cancel');
  const input = document.getElementById('settings-key-input');

  if (update) update.addEventListener('click', openKeyEntry);
  if (clear) clear.addEventListener('click', clearKey);
  if (save) save.addEventListener('click', saveNewKey);
  if (cancel) cancel.addEventListener('click', closeKeyEntry);
  if (input) input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveNewKey(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeKeyEntry(); }
  });
}

// ── Chat-model dropdown (dynamic from OpenRouter /models) ───────────
//
// The hardcoded <option> list in index.html is the fallback. On every
// settings-modal open we try Provider.listModels() and replace the
// dropdown with the live list (sorted alphabetically). If the fetch
// fails for any reason — no API key, no network, IPC error — the
// hardcoded shortlist stays. The saved active_model is preserved
// across the swap: if it's in the live list, it's selected; if it
// isn't (could be a model OpenRouter just retired, or a user-edited
// preferences.json), it's prepended as a synthetic option with a
// "(saved)" suffix so the user sees it's their persisted choice.

let _modelFallbackIds = null;

function captureModelFallback(modelSelect) {
  if (_modelFallbackIds !== null) return;
  _modelFallbackIds = Array.from(modelSelect.options)
    .map((o) => (o.value || o.text || '').trim())
    .filter(Boolean);
}

function fillModelOptions(modelSelect, ids, activeModel) {
  modelSelect.innerHTML = '';
  for (const id of ids) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    modelSelect.appendChild(opt);
  }
  if (activeModel) {
    const known = ids.includes(activeModel);
    if (!known) {
      const opt = document.createElement('option');
      opt.value = activeModel;
      opt.textContent = activeModel + ' (saved)';
      modelSelect.insertBefore(opt, modelSelect.firstChild);
    }
    modelSelect.value = activeModel;
  }
}

async function populateModelDropdown(activeModel) {
  const modelSelect = document.getElementById('settings-chat-model');
  if (!modelSelect) return;

  // Cache the hardcoded fallback list once, before we mutate the DOM.
  captureModelFallback(modelSelect);

  if (!isTauri) {
    // Browser preview: keep the hardcoded list as-is, just pre-select.
    if (activeModel) {
      const known = Array.from(modelSelect.options).some(
        (o) => o.value === activeModel || o.text === activeModel
      );
      if (!known) {
        const opt = document.createElement('option');
        opt.value = activeModel;
        opt.textContent = activeModel;
        modelSelect.insertBefore(opt, modelSelect.firstChild);
      }
      modelSelect.value = activeModel;
    }
    return;
  }

  // Loading state — preserve current selection visually.
  const wasDisabled = modelSelect.disabled;
  modelSelect.disabled = true;

  try {
    const models = await Provider.listModels();
    const ids = (Array.isArray(models) ? models : [])
      .map((m) => m && m.id)
      .filter((id) => typeof id === 'string' && id.length > 0)
      .sort((a, b) => a.localeCompare(b));

    if (ids.length === 0) {
      throw new Error('listModels returned no usable ids');
    }
    fillModelOptions(modelSelect, ids, activeModel);
  } catch (err) {
    // Fall back to the captured hardcoded shortlist. This keeps the
    // user productive even when the API key isn't set yet (the most
    // common cause of listModels failing at modal-open time).
    console.warn('listModels failed, using hardcoded fallback:', err);
    if (_modelFallbackIds && _modelFallbackIds.length > 0) {
      fillModelOptions(modelSelect, _modelFallbackIds, activeModel);
    }
  } finally {
    modelSelect.disabled = wasDisabled;
  }
}

// ── Probe-picker rendering ──────────────────────────────────────────

async function syncFromSource() {
  const host = document.getElementById('settings-probe-pickers');

  // Pull the flavour's probe bank + the user's current selection.
  let bank = null;
  let selection = {};
  let activeModel = null;
  if (isTauri) {
    try {
      bank = await Probes.getSet();
    } catch (err) {
      console.warn('Probes.getSet failed:', err);
    }
    try {
      const s = await Settings.get();
      selection = s.probe_selection || {};
      activeModel = s.active_model || null;
      // Dhyeya #14: hydrate the persistence-pass dropdowns too.
      applyExtraSettings(s);
      // v0.1.7: hydrate the target-ratio slider from persisted Settings.
      applyTargetSplitHeld(s.target_split_held);
    } catch (err) {
      console.warn('Settings.get failed:', err);
    }
  } else {
    // Browser preview: hydrate from localStorage mirror so a reload
    // of the static preview still reflects the user's last choice.
    applyTargetSplitHeld(null);
  }

  // Refresh the API-key status pill so it reflects current keychain
  // state when the modal opens (covers the case where the key was
  // added/cleared since the last open).
  refreshKeyStatusPill();
  closeKeyEntry();

  // Populate the chat-model dropdown from OpenRouter's live /models list
  // (v0.1.5). Falls back to the hardcoded shortlist in index.html if the
  // fetch fails (no API key, network down, IPC error). Saved active_model
  // is preserved across the swap.
  populateModelDropdown(activeModel);

  if (!host) return;

  if (!bank || !Array.isArray(bank.classes)) {
    host.innerHTML = '<p class="label-sub" style="margin: 0;">Probe bank unavailable — install a flavour first.</p>';
    return;
  }

  host.innerHTML = '';
  for (const cat of bank.classes) {
    const row = document.createElement('div');
    row.className = 'settings-row';

    const label = document.createElement('span');
    label.className = 'label';
    const slug = cat.class || cat.slug || '—';
    const display = cat.display_name || slug;
    label.innerHTML =
      escapeHtml(display) +
      '<span class="label-sub">' + escapeHtml(slug) + ' · ' + (cat.probes || []).length + ' probes in bank</span>';

    const value = document.createElement('span');
    value.className = 'value';

    const select = document.createElement('select');
    select.className = 'settings-select';
    select.setAttribute('data-axis', slug);

    const randomOpt = document.createElement('option');
    randomOpt.value = 'random';
    randomOpt.textContent = 'Random (draw fresh each run)';
    select.appendChild(randomOpt);

    for (const probe of cat.probes || []) {
      const opt = document.createElement('option');
      opt.value = probe.name || '';
      opt.textContent = (probe.name || '(unnamed)') +
        (probe.framing ? '  ·  ' + probe.framing : '');
      select.appendChild(opt);
    }

    const current = selection[slug];
    select.value = (current && current !== '') ? current : 'random';
    if (select.selectedIndex < 0) {
      // pinned probe-name no longer in bank — fall back to random
      select.value = 'random';
    }

    value.appendChild(select);
    row.appendChild(label);
    row.appendChild(value);
    host.appendChild(row);
  }
}

function readProbePickers() {
  const out = {};
  document.querySelectorAll('#settings-probe-pickers select[data-axis]').forEach((sel) => {
    const axis = sel.getAttribute('data-axis');
    const value = sel.value || 'random';
    if (axis) out[axis] = value;
  });
  return out;
}

function readChatModel() {
  const sel = document.getElementById('settings-chat-model');
  if (!sel) return null;
  return sel.value || null;
}

// Read the four additional Settings dropdowns introduced for persistence
// in v0.1.6 (Dhyeya #14). Missing elements return null in their slot so
// the save handler can skip them rather than overwriting saved state
// with empty strings.
function readExtraSettings() {
  const out = {
    ollama_model: null,
    refresh_hours: null,
    budget_usd: null,
    narration_mode: null,
  };
  const ollama = document.getElementById('settings-ollama-model');
  if (ollama && ollama.value) out.ollama_model = ollama.value;
  const refresh = document.getElementById('settings-refresh-hours');
  if (refresh && refresh.value !== '') {
    const n = parseInt(refresh.value, 10);
    if (!Number.isNaN(n)) out.refresh_hours = n;
  }
  const budget = document.getElementById('settings-budget-usd');
  if (budget && budget.value !== '') {
    const n = parseFloat(budget.value);
    if (!Number.isNaN(n)) out.budget_usd = n;
  }
  const narration = document.getElementById('settings-narration-mode');
  if (narration && narration.value) {
    // The Rust schema for NarrationMode is a serde enum; values are
    // serialised as PascalCase ("Raw" / "Economical" / "Functional" /
    // "Robust"). The HTML option values are lowercase. Map on the way
    // out so the backend receives what it expects.
    const map = {
      raw: 'Raw',
      economical: 'Economical',
      functional: 'Functional',
      robust: 'Robust',
    };
    out.narration_mode = map[narration.value] || null;
  }
  return out;
}

// Pre-select the four extra Settings dropdowns from saved Settings.
// Called from syncFromSource on every modal open so changes that
// happened elsewhere (or were saved by a different module) are
// reflected the next time the modal opens.
function applyExtraSettings(s) {
  if (!s) return;
  const ollama = document.getElementById('settings-ollama-model');
  if (ollama && s.ollama_model) {
    const known = Array.from(ollama.options).some((o) => o.value === s.ollama_model);
    if (!known) {
      const opt = document.createElement('option');
      opt.value = s.ollama_model;
      opt.textContent = s.ollama_model + ' (saved)';
      ollama.insertBefore(opt, ollama.firstChild);
    }
    ollama.value = s.ollama_model;
  }
  const refresh = document.getElementById('settings-refresh-hours');
  if (refresh && typeof s.filter_cartography_refresh_hours === 'number') {
    const candidate = String(s.filter_cartography_refresh_hours);
    const known = Array.from(refresh.options).some((o) => o.value === candidate);
    if (known) refresh.value = candidate;
  }
  const budget = document.getElementById('settings-budget-usd');
  if (budget && typeof s.filter_cartography_budget_usd === 'number') {
    // The HTML options are "0.10" / "0.25" / "0.50" / "1.00" / "2.00".
    // toFixed(2) normalises the JSON-decoded float so it matches exactly.
    const candidate = s.filter_cartography_budget_usd.toFixed(2);
    const known = Array.from(budget.options).some((o) => o.value === candidate);
    if (known) budget.value = candidate;
  }
  const narration = document.getElementById('settings-narration-mode');
  if (narration && s.narration_mode) {
    // Inverse of the readExtraSettings map.
    const map = { Raw: 'raw', Economical: 'economical', Functional: 'functional', Robust: 'robust' };
    const val = map[s.narration_mode] || String(s.narration_mode).toLowerCase();
    const known = Array.from(narration.options).some((o) => o.value === val);
    if (known) narration.value = val;
  }
}

// ── Target ratio (v0.1.7) ──────────────────────────────────────────
//
// Live-updates the readout text as the user drags the slider. The
// value is read from the DOM at save time and persisted to Settings
// alongside the other modal fields.
//
// Canon discipline: the labels in the markup say "Target ratio", the
// direction tag says "held-leaning" / "balanced" / "conflated-leaning",
// and at no point does the UI use the phrase "your split ratio" or
// "the split ratio" — those belong to the self-rated register an
// instrument cannot occupy (canon rule 5).

function wireTargetRatioControl() {
  const slider = document.getElementById('settings-target-slider');
  const valueEl = document.getElementById('settings-target-value');
  const tagEl = document.getElementById('settings-target-tag');
  if (!slider) return;
  slider.addEventListener('input', () => {
    const held = clampHeld(parseInt(slider.value, 10));
    if (valueEl) valueEl.textContent = formatRatio(held);
    if (tagEl) tagEl.textContent = directionTag(held);
  });
}

function readTargetSplitHeld() {
  const slider = document.getElementById('settings-target-slider');
  if (!slider) return null;
  const n = parseInt(slider.value, 10);
  if (!Number.isFinite(n)) return null;
  return clampHeld(n);
}

function applyTargetSplitHeld(held) {
  const slider = document.getElementById('settings-target-slider');
  const valueEl = document.getElementById('settings-target-value');
  const tagEl = document.getElementById('settings-target-tag');
  if (!slider) return;
  // null / undefined → leave whatever the renderer last had (or the
  // markup default). Otherwise clamp into range before applying.
  let h;
  if (typeof held === 'number' && Number.isFinite(held)) {
    h = clampHeld(held);
  } else {
    // Fall back to whatever the slider already shows, clamped.
    h = clampHeld(parseInt(slider.value, 10));
  }
  slider.value = String(h);
  if (valueEl) valueEl.textContent = formatRatio(h);
  if (tagEl) tagEl.textContent = directionTag(h);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
