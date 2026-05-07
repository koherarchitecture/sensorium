// settings-modal.js — settings overlay.
//
// In v0.1 this wires:
//   - Active-flavour read-only display.
//   - Probe selection per axis (Random / specific named probe), persisted
//     to Settings.probe_selection via Settings.update.
//   - API-key clear via ApiKey.clear.
// Other sections (Ollama, narration, workflow, about) render and are
// focusable but don't yet persist their values.

import { isTauri, Settings, ApiKey, Probes } from './ipc.js';

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

    if (isTauri) {
      try {
        const s = await Settings.get();
        s.probe_selection = probeSelection;
        await Settings.update(s);
      } catch (err) {
        console.warn('settings save failed:', err);
      }
    }

    if (_onChanged) _onChanged({ probeSelection });
    close();
  });

  // ── Provider section: clear API key ─────────────────────────────
  const clearKey = document.getElementById('settings-clear-key');
  if (clearKey) clearKey.addEventListener('click', async () => {
    if (!isTauri) return;
    try { await ApiKey.clear(); } catch (_) {}
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.getAttribute('data-open') === 'true') close();
  });
}

// ── Probe-picker rendering ──────────────────────────────────────────

async function syncFromSource() {
  const host = document.getElementById('settings-probe-pickers');
  if (!host) return;

  // Pull the flavour's probe bank + the user's current selection.
  let bank = null;
  let selection = {};
  if (isTauri) {
    try {
      bank = await Probes.getSet();
    } catch (err) {
      console.warn('Probes.getSet failed:', err);
    }
    try {
      const s = await Settings.get();
      selection = s.probe_selection || {};
    } catch (err) {
      console.warn('Settings.get failed:', err);
    }
  }

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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
