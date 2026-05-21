// settings-modal.js — settings overlay.
//
// In v0.1 this wires:
//   - Active-flavour read-only display.
//   - Probe selection per axis (Random / specific named probe), persisted
//     to Settings.probe_selection via Settings.update.
//   - API-key clear via ApiKey.clear.
// Other sections (Ollama, narration, workflow, about) render and are
// focusable but don't yet persist their values.

import { isTauri, Settings, ApiKey, Probes, Provider } from './ipc.js';

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

    if (isTauri) {
      try {
        const s = await Settings.get();
        s.probe_selection = probeSelection;
        if (activeModel) s.active_model = activeModel;
        await Settings.update(s);
      } catch (err) {
        console.warn('settings save failed:', err);
      }
    }

    if (_onChanged) _onChanged({ probeSelection, activeModel });
    close();
  });

  // ── Provider section: update / clear API key ────────────────────
  wireProviderKeyActions();

  // ── Flavour install buttons: not-yet-implemented notice ─────────
  // The HTML carries three install affordances (From URL, From file,
  // Browse registry) that v0.1 does not yet implement — the flavour
  // pipeline ships Sycophancy bundled and a future release will add
  // user-installable flavours. Until then, surface a clear inline
  // notice rather than leaving the buttons dead.
  const installUrlBtn = document.getElementById('settings-flavour-install-url');
  const installFileBtn = document.getElementById('settings-flavour-install-file');
  const browseBtn = document.getElementById('settings-flavour-browse');

  const showFlavourInstallNotice = () => {
    const host = installUrlBtn && installUrlBtn.parentElement;
    if (!host) return;
    let notice = host.parentElement.querySelector('.fr-install-notice');
    if (!notice) {
      notice = document.createElement('span');
      notice.className = 'label-sub fr-install-notice';
      notice.style.display = 'block';
      notice.style.marginTop = '8px';
      notice.style.color = 'var(--accent, #c75b39)';
      host.parentElement.appendChild(notice);
    }
    notice.textContent =
      'Flavour installation is not yet available in this release. ' +
      'Sycophancy ships bundled; future versions will add From URL, From file, and Browse registry.';
  };

  if (installUrlBtn) installUrlBtn.addEventListener('click', showFlavourInstallNotice);
  if (installFileBtn) installFileBtn.addEventListener('click', showFlavourInstallNotice);
  if (browseBtn) browseBtn.addEventListener('click', showFlavourInstallNotice);

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
    } catch (err) {
      console.warn('Settings.get failed:', err);
    }
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
