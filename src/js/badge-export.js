// badge-export.js — self-rated split-ratio badge entry + SVG export.
//
// CANON DISCIPLINE — split-ratio.md v1.1 rules 5 + 7:
//
//   Rule 5 (Name itself clearly):
//     • The badge this module produces IS the canon's self-rated badge.
//       Its title word is "SPLIT" (in line with the canon's visual
//       treatment); its subtitle is "split ratio"; the ratio is the
//       user's own declared N:M.
//     • The sensed-split badge in filter-panel.js is a DIFFERENT badge.
//       Its title word is "SENSED"; its subtitle is "sensed split".
//       The two are visually and verbally distinct — never confusable.
//
//   Rule 7 (Cohabit, do not replace):
//     • This module never auto-fills the self-rated value from the
//       instrument's sensed split. The user always types their own N:M.
//     • The UI never asks "is the sensed split your split ratio?" —
//       that would collapse the distinction the canon protects. The
//       only question this module ever asks is "what split ratio do
//       you declare for this artefact?"
//
// The exported badge is an SVG string (or downloadable file). Self-
// contained — no external font / image / script references — so it
// embeds cleanly in any artefact the practitioner publishes.

import { isTauri, Settings } from './ipc.js';

const MIN_HELD = 1;
const MAX_HELD = 9;
const DEFAULT_HELD = 7;

const SVG_W = 240;
const SVG_H = 84;

let _modalEl = null;

export function init() {
  wireOpenButton();
  // Modal is built on first open — keeps the markup lazy.
}

function wireOpenButton() {
  const btn = document.getElementById('settings-publish-badge-btn');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    openModal();
  });
}

// Build the modal once and reuse. Markup is small; CSS lives inline
// for portability so this module can be enabled / disabled without
// touching index.html beyond the open button.
function ensureModal() {
  if (_modalEl) return _modalEl;

  const root = document.createElement('div');
  root.className = 'badge-export-modal';
  root.id = 'badge-export-modal';
  root.setAttribute('data-open', 'false');
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="be-backdrop" data-action="close"></div>
    <div class="be-panel" role="dialog" aria-labelledby="be-title">
      <header class="be-head">
        <h2 id="be-title">Declare your split ratio</h2>
        <p class="be-intro">
          Read your own work. Declare the proportion at which the discipline
          holds in this artefact. This is your self-rating — the instrument's
          sensed split is a different reading and is never folded into this.
        </p>
      </header>
      <div class="be-body">
        <label class="be-label" for="be-slider">Your split ratio for this artefact</label>
        <div class="be-slider-row">
          <span class="be-anchor">held</span>
          <input type="range" id="be-slider" class="be-slider"
                 min="${MIN_HELD}" max="${MAX_HELD}" step="1" value="${DEFAULT_HELD}" />
          <span class="be-anchor">conflated</span>
        </div>
        <div class="be-readout">
          <span class="be-ratio" id="be-ratio">${DEFAULT_HELD}:${10 - DEFAULT_HELD}</span>
        </div>
        <p class="be-help">
          The canon's range is 1:9 through 9:1. The endpoints 0 and 10 are
          excluded by design — no real artefact achieves clean separation
          everywhere.
        </p>
        <div class="be-preview" id="be-preview"><!-- live SVG --></div>
      </div>
      <footer class="be-foot">
        <button type="button" class="be-btn-secondary" data-action="copy-svg">Copy SVG</button>
        <button type="button" class="be-btn-secondary" data-action="download-svg">Download SVG</button>
        <button type="button" class="be-btn-secondary" data-action="close">Close</button>
      </footer>
    </div>
  `;
  document.body.appendChild(root);

  // Inline styles — kept here so the module is portable. Mirrors the
  // overall paper / mono / serif palette already loaded by koher-ui.
  const style = document.createElement('style');
  style.textContent = `
    .badge-export-modal { display: none; position: fixed; inset: 0; z-index: 1000;
      align-items: center; justify-content: center; font-family: var(--type-body, serif); }
    .badge-export-modal[data-open="true"] { display: flex; }
    .be-backdrop { position: absolute; inset: 0; background: rgba(20, 18, 16, 0.45); }
    .be-panel { position: relative; width: 460px; max-width: 92vw; padding: 22px 26px;
      background: var(--paper-bg, #F7F3ED); color: var(--ink-paper-1, #2D3127);
      border: 1px solid var(--paper-rule, rgba(0,0,0,0.18)); border-radius: 4px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.32); }
    .be-head h2 { margin: 0 0 8px; font-family: var(--type-display, serif);
      font-weight: 500; font-size: 19px; letter-spacing: 0.01em; }
    .be-intro { margin: 0 0 18px; font-style: italic; font-size: 13.5px; line-height: 1.55;
      color: var(--ink-paper-2, #4a4844); }
    .be-label { display: block; font-family: var(--type-mono, monospace); font-size: 11px;
      letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-paper-2);
      margin-bottom: 8px; }
    .be-slider-row { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
    .be-anchor { font-family: var(--type-mono); font-size: 10.5px; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--ink-paper-3); flex: 0 0 auto; }
    .be-slider { flex: 1 1 auto; -webkit-appearance: none; appearance: none;
      height: 4px; background: var(--paper-rule-2); border-radius: 2px; outline: none; }
    .be-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;
      width: 18px; height: 18px; border-radius: 50%;
      background: var(--accent, #C75B39); border: 2px solid var(--paper-bg); cursor: pointer; }
    .be-slider::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%;
      background: var(--accent, #C75B39); border: 2px solid var(--paper-bg); cursor: pointer; }
    .be-readout { text-align: center; margin: 8px 0 4px; }
    .be-ratio { font-family: var(--type-mono); font-size: 28px; font-weight: 500;
      color: var(--ink-paper-1); letter-spacing: 0.02em; }
    .be-help { margin: 4px 0 16px; font-family: var(--type-body); font-style: italic;
      font-size: 12.5px; line-height: 1.5; color: var(--ink-paper-3); }
    .be-preview { display: flex; justify-content: center; padding: 12px;
      background: rgba(128, 128, 128, 0.06); border: 1px dashed var(--paper-rule-2);
      border-radius: 3px; margin-bottom: 12px; }
    .be-foot { display: flex; gap: 8px; justify-content: flex-end; }
    .be-btn-secondary { font-family: var(--type-mono); font-size: 12px;
      padding: 6px 12px; border-radius: 3px; cursor: pointer;
      background: transparent; color: var(--ink-paper-1);
      border: 1px solid var(--paper-rule-2); }
    .be-btn-secondary:hover { border-color: var(--hue-bronze, #C75B39);
      color: var(--hue-bronze, #C75B39); }
  `;
  document.head.appendChild(style);

  // Wire actions.
  root.addEventListener('click', (e) => {
    const action = e.target && e.target.getAttribute && e.target.getAttribute('data-action');
    if (action === 'close') closeModal();
    if (action === 'copy-svg') copyCurrentSvg();
    if (action === 'download-svg') downloadCurrentSvg();
  });
  const slider = root.querySelector('#be-slider');
  if (slider) {
    slider.addEventListener('input', () => {
      renderPreview(clampHeld(parseInt(slider.value, 10)));
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.getAttribute('data-open') === 'true') closeModal();
  });

  _modalEl = root;
  return root;
}

async function openModal() {
  const root = ensureModal();
  // Initial value: read the user's target ratio as a SUGGESTION for the
  // self-rated value (the two are different registers — see canon rule 7 —
  // but they're not unrelated; the user's target is a reasonable starting
  // point the user can then adjust to reflect what they actually see in
  // their artefact). This is suggestion, NOT auto-fill of the sensed split.
  let held = DEFAULT_HELD;
  if (isTauri) {
    try {
      const s = await Settings.get();
      held = clampHeld(s.target_split_held);
    } catch (_) { /* fall through to default */ }
  }
  const slider = root.querySelector('#be-slider');
  if (slider) slider.value = String(held);
  setText('be-ratio', `${held}:${10 - held}`);
  renderPreview(held);

  root.setAttribute('data-open', 'true');
  root.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  if (!_modalEl) return;
  _modalEl.setAttribute('data-open', 'false');
  _modalEl.setAttribute('aria-hidden', 'true');
}

function renderPreview(held) {
  const previewEl = document.getElementById('be-preview');
  if (!previewEl) return;
  setText('be-ratio', `${held}:${10 - held}`);
  previewEl.innerHTML = buildBadgeSvg(held);
}

function copyCurrentSvg() {
  const svg = buildBadgeSvg(currentHeld());
  navigator.clipboard.writeText(svg).then(
    () => flashFootMessage('SVG copied'),
    () => flashFootMessage('Copy failed'),
  );
}

function downloadCurrentSvg() {
  const held = currentHeld();
  const svg = buildBadgeSvg(held);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `split-ratio-${held}-${10 - held}.svg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function currentHeld() {
  const slider = document.getElementById('be-slider');
  return clampHeld(slider ? parseInt(slider.value, 10) : DEFAULT_HELD);
}

function flashFootMessage(msg) {
  if (!_modalEl) return;
  const foot = _modalEl.querySelector('.be-foot');
  if (!foot) return;
  let tag = foot.querySelector('.be-flash');
  if (!tag) {
    tag = document.createElement('span');
    tag.className = 'be-flash';
    tag.style.cssText = 'font-family: var(--type-mono); font-size: 11px; color: var(--ink-paper-2); margin-right: auto; font-style: italic;';
    foot.insertBefore(tag, foot.firstChild);
  }
  tag.textContent = msg;
  setTimeout(() => { if (tag) tag.textContent = ''; }, 2400);
}

// Build a self-contained SVG with no external font references so the
// badge embeds cleanly anywhere. Visual register:
//   • Title word SPLIT in mono, letter-spaced, top-left.
//   • Italic "split ratio" subtitle below the title (canonical phrase).
//   • Divided string with 11 tick marks (anchors + 9 interior).
//   • Sepia bridge marker at the chosen N:M position.
//   • N:M numeral, top-right.
// Per canon rule 5: the only place the canonical phrase "split ratio"
// appears in this codebase is here, on this self-rated badge.
function buildBadgeSvg(heldRaw) {
  const held = clampHeld(heldRaw);
  const conflated = 10 - held;

  // Marker x position: held = 1 → near left ("held" pole); held = 9 →
  // near right ("conflated" pole). Track spans x = [40, 200] (160 wide).
  const tickStart = 40;
  const tickEnd = 200;
  const trackLen = tickEnd - tickStart;
  // 11 tick marks: positions [held=0]..[held=10] mapped to track.
  const markerX = tickStart + trackLen * (held / 10);

  // Inline SVG. No external resources. Colours are explicit hex values
  // (not CSS variables) because consumers may embed this in contexts
  // where the variables aren't defined.
  const ink = '#2D3127';
  const inkMuted = '#5a5754';
  const paper = '#F7F3ED';
  const sepia = '#C75B39';
  const rule = 'rgba(45, 49, 39, 0.28)';

  // Tick marks — 11 verticals across the track.
  let ticks = '';
  for (let i = 0; i <= 10; i++) {
    const x = tickStart + trackLen * (i / 10);
    const len = (i === 0 || i === 10) ? 9 : (i === 5 ? 7 : 5);
    ticks += `<line x1="${x}" y1="${52 - len / 2}" x2="${x}" y2="${52 + len / 2}" stroke="${rule}" stroke-width="1"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}" role="img" aria-label="Split ratio ${held}:${conflated}">
  <rect x="0.5" y="0.5" width="${SVG_W - 1}" height="${SVG_H - 1}" rx="3" fill="${paper}" stroke="${rule}"/>
  <text x="14" y="22" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" font-weight="600" letter-spacing="2.4" fill="${sepia}">SPLIT</text>
  <text x="14" y="36" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="12" fill="${inkMuted}">split ratio</text>
  <text x="${SVG_W - 14}" y="28" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="18" font-weight="500" fill="${ink}">${held}:${conflated}</text>
  <text x="${tickStart - 6}" y="55" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="8" letter-spacing="0.8" fill="${inkMuted}">HELD</text>
  <text x="${tickEnd + 6}" y="55" text-anchor="start" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="8" letter-spacing="0.8" fill="${inkMuted}">CONFLATED</text>
  <line x1="${tickStart}" y1="52" x2="${tickEnd}" y2="52" stroke="${rule}" stroke-width="1"/>
  ${ticks}
  <circle cx="${markerX}" cy="52" r="6" fill="${sepia}" stroke="${paper}" stroke-width="2"/>
  <text x="14" y="${SVG_H - 10}" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="10" fill="${inkMuted}">self-rated · splitdomaincognition.org/split-ratio</text>
</svg>`;
}

function clampHeld(n) {
  if (!Number.isFinite(n)) return DEFAULT_HELD;
  return Math.max(MIN_HELD, Math.min(MAX_HELD, Math.round(n)));
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
