// probes-modal.js — probe-set transparency modal.
//
// Surfaces the embedded probe bank to the user. v0.1 ships with the
// bank baked into HTML; in a Tauri runtime we could fetch it via
// `get_probe_set` and render dynamically, but that's out of scope for
// the first wiring pass — the modal's content matches the static bank
// shipped in markup.

export function init() {
  const modal = document.getElementById('probes-modal');
  const open = document.querySelector('.show-probes');
  const closeBtn = document.getElementById('probes-close');
  const footClose = document.getElementById('probes-foot-close');
  const backdrop = document.getElementById('probes-backdrop');

  if (!modal) return;

  const show = () => {
    modal.setAttribute('data-open', 'true');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  };
  const hide = () => {
    modal.setAttribute('data-open', 'false');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  };

  if (open) open.addEventListener('click', show);
  if (closeBtn) closeBtn.addEventListener('click', hide);
  if (footClose) footClose.addEventListener('click', hide);
  if (backdrop) backdrop.addEventListener('click', hide);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.getAttribute('data-open') === 'true') hide();
  });
}
