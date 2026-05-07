// mode-dropdown.js — narration mode selector in the panel header.
//
// Modes change two things visible to the user: the cost estimate for a
// full refresh, and (downstream) the per-probe response cap that drives
// that cost. The cost lever is the probe-response token cap per spec
// §10.6. Costs here reflect a 36-probe full refresh (12 classes × 3
// used probes).
//
// On selection, the panel's data-mode attribute is updated; CSS hooks
// off this attribute to surface the active mode in the header. The
// actual settings persistence happens in settings-modal.js (or via the
// first-run wizard's calibration step).

const COSTS = {
  raw: '~$0.09',
  economical: '~$0.12',
  functional: '~$0.18',
  robust: '~$0.33',
};

let _onChange = null;

export function init({ onChange } = {}) {
  _onChange = onChange || null;

  const panel = document.querySelector('.panel');
  const modeValue = document.getElementById('mode-value');
  const costVal = document.getElementById('cost-val');
  const switcher = document.getElementById('mode-switcher');
  const dropdown = document.getElementById('mode-dropdown');

  if (!switcher || !dropdown) return;

  const open = () => {
    dropdown.setAttribute('data-open', 'true');
    switcher.setAttribute('aria-expanded', 'true');
  };
  const close = () => {
    dropdown.setAttribute('data-open', 'false');
    switcher.setAttribute('aria-expanded', 'false');
  };
  const toggle = () => {
    const isOpen = dropdown.getAttribute('data-open') === 'true';
    if (isOpen) close(); else open();
  };

  switcher.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });

  document.querySelectorAll('.mode-option').forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const mode = opt.getAttribute('data-mode-option');
      panel.setAttribute('data-mode', mode);
      if (modeValue) modeValue.textContent = mode;
      if (costVal) costVal.textContent = COSTS[mode] || '';
      document.querySelectorAll('.mode-option').forEach((o) => o.removeAttribute('aria-current'));
      opt.setAttribute('aria-current', 'true');
      close();
      if (_onChange) _onChange(mode);
    });
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

export function costFor(mode) {
  return COSTS[mode] || '';
}
