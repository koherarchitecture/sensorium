// model-pick.js — top-bar chat-model picker (v0.1.6).
//
// Wires the title-bar `.model-pick` button to a real popover dropdown
// that lists every model OpenRouter exposes (via Provider.listModels()),
// preserves the current active_model, and on selection: (a) saves to
// Settings.active_model, (b) updates the header badge, (c) hands the
// new model to chat.setModel() so the next message routes correctly.
//
// Dhyeya #05 (week-09 friction log): the button had hover/click effects
// but didn't open a menu. v0.1.5 left it inert; v0.1.6 wires it.
//
// Visual + functional parity with the Settings → Chat model dropdown:
// same live OpenRouter list, same fallback shortlist on IPC failure,
// same "(saved)" prepend convention if the active_model isn't in the
// live list. The two surfaces share the source-of-truth (Settings.active_model);
// changes in one update the other on next render.

import { isTauri, Settings, Provider } from './ipc.js';

let _modelIds = null;
let _onSelect = null;

const FALLBACK_MODELS = [
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.7',
  'openai/gpt-5-mini',
  'meta-llama/llama-3.3-70b-instruct',
  'cohere/command-a',
];

export function init({ onSelect } = {}) {
  _onSelect = onSelect || null;
  const wrap = document.getElementById('model-pick-wrap');
  const btn = document.getElementById('model-pick-btn');
  const menu = document.getElementById('model-pick-menu');
  const filter = document.getElementById('model-pick-filter');
  if (!wrap || !btn || !menu) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = wrap.getAttribute('data-open') === 'true';
    if (open) closeMenu();
    else openMenu();
  });

  if (filter) {
    filter.addEventListener('input', () => applyFilter(filter.value.trim()));
    filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    });
  }

  // Outside click closes the menu.
  document.addEventListener('click', (e) => {
    if (wrap.getAttribute('data-open') !== 'true') return;
    if (!wrap.contains(e.target)) closeMenu();
  });

  // Escape closes the menu from anywhere.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && wrap.getAttribute('data-open') === 'true') closeMenu();
  });
}

async function openMenu() {
  const wrap = document.getElementById('model-pick-wrap');
  const btn = document.getElementById('model-pick-btn');
  if (!wrap) return;
  wrap.setAttribute('data-open', 'true');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  await ensurePopulated();
  const filter = document.getElementById('model-pick-filter');
  if (filter) { filter.value = ''; setTimeout(() => filter.focus(), 0); }
  applyFilter('');
}

function closeMenu() {
  const wrap = document.getElementById('model-pick-wrap');
  const btn = document.getElementById('model-pick-btn');
  if (!wrap) return;
  wrap.setAttribute('data-open', 'false');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

async function ensurePopulated() {
  if (_modelIds && _modelIds.length > 0) return;
  if (!isTauri) {
    _modelIds = FALLBACK_MODELS.slice();
    renderList();
    return;
  }
  try {
    const models = await Provider.listModels();
    const ids = (Array.isArray(models) ? models : [])
      .map((m) => m && m.id)
      .filter((id) => typeof id === 'string' && id.length > 0)
      .sort((a, b) => a.localeCompare(b));
    if (ids.length === 0) throw new Error('empty model list');
    _modelIds = ids;
  } catch (err) {
    console.warn('model-pick listModels failed, using fallback:', err);
    _modelIds = FALLBACK_MODELS.slice();
  }
  renderList();
}

async function getActiveModel() {
  if (!isTauri) return null;
  try {
    const s = await Settings.get();
    return s && s.active_model ? s.active_model : null;
  } catch (_) { return null; }
}

function renderList() {
  const list = document.getElementById('model-pick-list');
  if (!list || !_modelIds) return;
  getActiveModel().then((active) => {
    const ids = _modelIds.slice();
    if (active && !ids.includes(active)) {
      ids.unshift(active);
    }
    list.innerHTML = '';
    for (const id of ids) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'model-pick-row';
      row.setAttribute('role', 'option');
      row.setAttribute('data-model-id', id);
      const isActive = id === active;
      row.textContent = isActive ? `${id} (active)` : id;
      if (isActive) row.setAttribute('aria-selected', 'true');
      row.addEventListener('click', () => selectModel(id));
      list.appendChild(row);
    }
  });
}

function applyFilter(query) {
  const list = document.getElementById('model-pick-list');
  if (!list) return;
  const q = query.toLowerCase();
  const rows = list.querySelectorAll('.model-pick-row');
  let visible = 0;
  rows.forEach((row) => {
    const id = (row.getAttribute('data-model-id') || '').toLowerCase();
    const match = !q || id.includes(q);
    row.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  // Show empty state if filter eliminates everything.
  let empty = list.querySelector('.model-pick-empty-filter');
  if (visible === 0 && q) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'model-pick-empty model-pick-empty-filter';
      empty.textContent = 'No models match this filter.';
      list.appendChild(empty);
    }
  } else if (empty) {
    empty.remove();
  }
}

async function selectModel(id) {
  if (!isTauri) {
    updateHeader(id);
    closeMenu();
    if (_onSelect) _onSelect(id);
    return;
  }
  try {
    const s = await Settings.get();
    s.active_model = id;
    await Settings.update(s);
  } catch (err) {
    console.warn('model-pick: Settings.update failed:', err);
  }
  updateHeader(id);
  closeMenu();
  if (_onSelect) _onSelect(id);
  renderList();
}

function updateHeader(model) {
  const el = document.getElementById('header-model-value');
  if (el) el.textContent = String(model).replace('/', ' / ');
}

// Allow external callers (e.g. settings-modal save) to invalidate the
// cached list — useful if a future flavour install adds a model.
export function invalidateModelList() {
  _modelIds = null;
}
