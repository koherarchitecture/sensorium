// rows.js — tap-to-inspect row toggling.
//
// Each .row in the panel is collapsible. Tapping anywhere on the row
// header toggles its open state and flips the disclosure marker. We
// avoid swallowing clicks inside the expanded detail (so the user can
// select text inside the inspection drawer).

export function init() {
  document.querySelectorAll('.row').forEach((row) => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.row-detail')) return;
      const open = row.getAttribute('data-open') === 'true';
      row.setAttribute('data-open', open ? 'false' : 'true');
      const toggle = row.querySelector('.row-toggle');
      if (toggle) toggle.textContent = open ? '▸' : '▾';
    });
  });
}
