// filter-panel.js — render a Fingerprint into the cartography panel.
//
// The panel HTML ships with a static sample baked in so the design
// preview shows representative content without a backend. When a real
// Fingerprint arrives via run_calibration / run_full_refresh, this
// module replaces the row contents and the reading section. When no
// fingerprint is available (preview, IPC error, first-run skipped),
// the static sample is left in place.

import { isTauri, Calibration, Settings, SensedSplit } from './ipc.js';
import { applyFingerprint as applyStrip } from './calibration-strip.js';
import { updateFromFingerprint as applyCategoryVis } from './category-vis.js';
import { getTargetSplitHeldSync, getTargetSplitHeld } from './target-ratio.js';

let _state = {
  fingerprint: null,
  enabledClasses: null,
};

export function init() {
  // Small header icon → full refresh (run_full_refresh).
  document.querySelectorAll('[data-action="refresh"]').forEach((el) => {
    el.addEventListener('click', refresh);
  });
  // The prominent "Calibrate this model" CTA in the awaiting card → the THIN
  // calibration (run_calibration), the same proven path the first-run wizard
  // uses. It previously shared data-action="refresh" → run_full_refresh, the
  // heavier path, and silently swallowed errors — so after a model change the
  // button cleared its spinner with nothing to show and read as dead.
  document.querySelectorAll('[data-action="calibrate"]').forEach((el) => {
    el.addEventListener('click', calibrateFromCTA);
  });
}

// Handler for the awaiting-state "Calibrate this model" button: runs the thin
// calibration with visible running state, and surfaces a failure instead of
// swallowing it (the old silent console.warn read as "the button is broken").
async function calibrateFromCTA() {
  if (!isTauri) return;
  const btns = document.querySelectorAll('[data-action="calibrate"]');
  const msg = document.querySelector('.sensed-split-awaiting-msg');
  btns.forEach((b) => b.setAttribute('data-state', 'running'));
  try {
    const fp = await Calibration.run();   // thin calibration — the wizard's path
    applyFingerprint(fp);                 // flips the badge out of 'awaiting'
    import('./usage-line.js').then((m) => m.refresh(true)).catch(() => { /* non-fatal */ });
  } catch (err) {
    if (msg) msg.textContent = `Calibration failed: ${(err && err.message) ? err.message : err}`;
    // eslint-disable-next-line no-console
    console.warn('calibrate (CTA) failed', err);
  } finally {
    btns.forEach((b) => b.removeAttribute('data-state'));
  }
}

export function setEnabledClasses(classes) {
  _state.enabledClasses = (classes || []).map((c) => String(c).toLowerCase());
  applyClassFilter();
}

/// Reset the cartography panel to the awaiting-calibration state.
/// Called when the user switches to a different chat model: the
/// previous fingerprint is no longer valid for the new model, so we
/// clear it and indicate that calibration is needed. The user can
/// click the refresh button (data-action="refresh") to run a fresh
/// calibration against the new model.
///
/// Dhyeya #09: panel used to keep showing the previous model's name
/// and reading after a model change, which read as broken.
export function resetForModelChange(newModel) {
  _state.fingerprint = null;
  const titleEl = document.querySelector('.panel-title');
  if (titleEl) {
    const leaf = newModel ? String(newModel).split('/').pop() : '';
    titleEl.textContent = leaf || 'awaiting first calibration';
  }
  const metaSpans = document.querySelectorAll('.panel-meta > span');
  if (metaSpans.length >= 5) {
    metaSpans[0].textContent = '— probes';
    metaSpans[4].textContent = 'not yet calibrated';
  }
  // Hide tone-cues row — it was derived from a fingerprint that's now stale.
  import('./tone-suggestions.js')
    .then((m) => m.update(null))
    .catch(() => { /* non-fatal */ });

  // Flip sensed-split badge to awaiting — the dial card stays visible
  // with the Calibrate-this-model button as the CTA. User clicks it
  // explicitly to run the new model's calibration; we don't auto-trigger
  // any more — auto-trigger raced the manual-click handler and made the
  // button feel "not pressable for a long time" (reported 22 May 2026).
  const badge = document.getElementById('sensed-split-badge');
  if (badge) badge.setAttribute('data-state', 'awaiting');
  DIAL.reset();
}

export function applyFingerprint(fp) {
  _state.fingerprint = fp;
  if (!fp) return;

  // v0.1.3: refresh suggested-tone pills above the composer on every
  // fingerprint update. Dynamic import keeps the module dependency
  // here local (the panel's other consumers don't need to know about
  // tones). Fire-and-forget — the suggestion render is best-effort.
  import('./tone-suggestions.js')
    .then((m) => m.update(fp))
    .catch((e) => console.warn('tone-suggestions import failed:', e));

  // v0.1.7: refresh the sensed-split badge. Reads the sensed split via
  // IPC (Rust side computes from the fingerprint under the active
  // flavour's split_ratio_mapping). Hidden when the flavour declares no
  // mapping (legacy flavours) or the fingerprint can't produce a reading.
  refreshSensedSplitBadge(fp);

  // Panel header — model name, probe count, refreshed timestamp.
  // The HTML ships with placeholders ("claude-sonnet-4.6", "38 probes",
  // "refreshed 12 days ago"); these get replaced with real values once
  // a fingerprint lands.
  const titleEl = document.querySelector('.panel-title');
  if (titleEl && fp.model) {
    // Display the model leaf (after the last `/`) for compactness.
    const leaf = String(fp.model).split('/').pop();
    titleEl.textContent = leaf || fp.model;
  }
  const metaSpans = document.querySelectorAll('.panel-meta > span');
  if (metaSpans.length >= 5) {
    if (typeof fp.total_probes === 'number') {
      metaSpans[0].textContent = `${fp.total_probes} probes`;
    }
    metaSpans[4].textContent = `refreshed ${relativeTime(fp.calibrated_at)}`;
  }

  // Per-row updates.
  if (Array.isArray(fp.classes)) {
    fp.classes.forEach((cr) => {
      const slug = cr.class && (typeof cr.class === 'string' ? cr.class.toLowerCase() : String(cr.class).toLowerCase());
      const row = document.querySelector(`.row[data-class="${slug}"]`);
      if (!row) return;

      const verdictEl = row.querySelector('.row-verdict-raw');
      if (verdictEl) verdictEl.textContent = humanizeVerdict(cr.verdict);

      // Per-class line from narration, if present.
      const lineEl = row.querySelector('.row-behaviour');
      if (lineEl && fp.reading && fp.reading.per_class_lines) {
        const line = fp.reading.per_class_lines[slug];
        if (line) lineEl.textContent = line;
      }

      // Update the verdict symbol in the row head (●/◐/○).
      const symEl = row.querySelector('.row-sym');
      if (symEl) {
        // Strip any existing sym-* class, then attach the verdict's class.
        const cls = symEl.className.split(/\s+/).filter((c) => !c.startsWith('sym-')).join(' ');
        symEl.className = `${cls} sym-${String(cr.verdict || '').toLowerCase()}`.trim();
        symEl.textContent = symbolFor(cr.verdict);
      }
    });
  }

  // Reading section — paragraphs replace the static sample in all
  // three mode containers, so whichever mode is active surfaces the
  // freshly narrated content. Pattern observations land only in the
  // robust mode's pattern block (the only place that surfaces them).
  if (fp.reading) {
    if (Array.isArray(fp.reading.summary_paragraphs) && fp.reading.summary_paragraphs.length) {
      // The narrator's prompt says "no headings" but Haiku occasionally
      // adds a `# Filter-Cartography Reading: <model>` line anyway.
      // We render markdown so other formatting (bold, italic, code)
      // surfaces correctly when it does appear.
      const html = fp.reading.summary_paragraphs.map(renderMd).join('');
      ['.reading-economical', '.reading-functional', '.reading-robust'].forEach((sel) => {
        const el = document.querySelector(sel);
        if (el) el.innerHTML = html;
      });
    }
    if (fp.reading.pattern_observations) {
      const pattern = document.querySelector('.reading-robust .pattern-block');
      if (pattern) {
        pattern.innerHTML = `<h4>Cross-class observations</h4>${renderMd(fp.reading.pattern_observations)}`;
      }
    }
  }

  applyStrip(fp);
  applyCategoryVis(fp);
  applyClassFilter();
}

export async function refresh() {
  if (!isTauri) {
    // Preview: nothing to refresh — leave static sample in place.
    return;
  }
  // Mark ALL refresh affordances as running: the small icon in the
  // panel header AND the big "Calibrate this model" button in the
  // sensed-split awaiting card. querySelector (singular) used to miss
  // the second one.
  const btns = document.querySelectorAll('[data-action="refresh"]');
  btns.forEach((b) => b.setAttribute('data-state', 'running'));
  try {
    const fp = await Calibration.fullRefresh();
    applyFingerprint(fp);
    // After a refresh, usage on the OpenRouter key has changed.
    // Best-effort update of the usage line; failures stay quiet.
    import('./usage-line.js')
      .then((m) => m.refresh(true))
      .catch(() => { /* non-fatal */ });
  } catch (err) {
    // Surface the failure instead of swallowing it. (run_full_refresh is in
    // fact wired — identical to run_calibration except probe count — so a
    // failure here is a runtime cause worth showing: Ollama down, key
    // missing, budget exhausted. The old silent console.warn made a failed
    // refresh read as a dead button.)
    const awaitingMsg = document.querySelector('.sensed-split-awaiting-msg');
    if (awaitingMsg) awaitingMsg.textContent = `Refresh failed: ${(err && err.message) ? err.message : err}`;
    const metaSpans = document.querySelectorAll('.panel-meta > span');
    if (metaSpans.length >= 5) metaSpans[4].textContent = 'refresh failed';
    // eslint-disable-next-line no-console
    console.warn('refresh failed', err);
  } finally {
    btns.forEach((b) => b.removeAttribute('data-state'));
  }
}

export async function calibrate() {
  if (!isTauri) return null;
  try {
    const fp = await Calibration.run();
    applyFingerprint(fp);
    return fp;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('calibration failed', err);
    return null;
  }
}

// ── Internals ───────────────────────────────────────────────────────

function applyClassFilter() {
  if (!_state.enabledClasses || _state.enabledClasses.length === 0) return;
  const enabled = new Set(_state.enabledClasses);
  document.querySelectorAll('.row[data-class]').forEach((row) => {
    const slug = row.getAttribute('data-class');
    row.style.display = enabled.has(slug) ? '' : 'none';
  });
}

function humanizeVerdict(v) {
  if (!v) return '';
  const s = String(v).toLowerCase();
  switch (s) {
    case 'substantive': return 'engages';
    case 'redirect':    return 'redirects';
    case 'templated':   return 'templates on';
    case 'refusal':     return 'refuses';
    case 'silent':      return 'falls silent';
    case 'mixed':       return 'mixed';
    default:            return s;
  }
}

function symbolFor(v) {
  const s = String(v || '').toLowerCase();
  switch (s) {
    case 'substantive': return '●';
    case 'redirect':    return '◐';
    case 'templated':   return '◐';
    case 'refusal':     return '○';
    case 'silent':      return '○';
    case 'mixed':       return '◐';
    default:            return '○';
  }
}

// Render an ISO-8601 / RFC-3339 timestamp as "X minutes ago" / "X hours ago"
// / "X days ago". Falls back to "just now" for sub-minute deltas, and to the
// raw string if parsing fails — better to show something than nothing.
function relativeTime(iso) {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffMs = Date.now() - t;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ── Sensed-split badge (v0.1.7) ─────────────────────────────────────
//
// Reads the sensed split via IPC from the current fingerprint and
// paints the badge under the panel header. Hidden when the flavour
// declares no `split_ratio_mapping` (legacy flavours) or the IPC
// returns null.
//
// Canon discipline (split-ratio.md v1.1 rule 5): every UI surface in
// this function uses the phrase "sensed split", never "split ratio" /
// "your split ratio". The target marker is labelled "your target
// ratio" — the user's setting, not a self-rating.

// Galvanometer dial — v0.1.7 redesign 22 May 2026.
// Replaces the prior horizontal-marker badge. Architecture: a wobble
// loop runs at requestAnimationFrame independently of reading updates;
// setSensedSplit() updates the target reading and the needle eases
// toward it; pulseChatRound() injects a transient flick into the wobble
// signal each chat round.
//
// Geometry: 180° arc, pivot at (160, 168), radius 128. held ∈ [1, 9]
// maps to angle ∈ [-90°, +90°] from vertical. Step = 22.5°.

const DIAL = (function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CX = 160, CY = 168, R = 128;

  // Dial state (singleton).
  const state = {
    targetHeld:    5,
    targetTarget:  7,
    band:          1,
    perDial:       [],
    displayedHeld: 5,
    pulseStart:    -100,
    pulseAmp:      0,
    tStart:        performance.now() / 1000,
    initialised:   false,
    running:       false,
    lastRatio:     null,
  };

  function heldToAngle(h) { return (h - 5) * 22.5; }
  function arcPoint(deg, radius) {
    const a = (deg - 90) * Math.PI / 180;
    return { x: CX + radius * Math.cos(a), y: CY + radius * Math.sin(a) };
  }

  function renderTicks() {
    const group = document.getElementById('sensed-split-ticks');
    if (!group) return;
    group.innerHTML = '';
    // Minor ticks at half-integer positions (1.5, 2.5, ..., 8.5).
    for (let h = 1.5; h < 9; h += 1) {
      const a = heldToAngle(h);
      const p1 = arcPoint(a, R - 3);
      const p2 = arcPoint(a, R - 9);
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('class', 'tick-minor');
      l.setAttribute('x1', p1.x.toFixed(1));
      l.setAttribute('y1', p1.y.toFixed(1));
      l.setAttribute('x2', p2.x.toFixed(1));
      l.setAttribute('y2', p2.y.toFixed(1));
      group.appendChild(l);
    }
    // Major ticks at integers 1..9 + numerals.
    for (let h = 1; h <= 9; h++) {
      const a = heldToAngle(h);
      const p1 = arcPoint(a, R - 1);
      const p2 = arcPoint(a, R - 14);
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('class', 'tick-major');
      l.setAttribute('x1', p1.x.toFixed(1));
      l.setAttribute('y1', p1.y.toFixed(1));
      l.setAttribute('x2', p2.x.toFixed(1));
      l.setAttribute('y2', p2.y.toFixed(1));
      group.appendChild(l);
      const np = arcPoint(a, R + 12);
      const t = document.createElementNS(SVG_NS, 'text');
      const isMajor = (h === 1 || h === 5 || h === 9);
      t.setAttribute('class', isMajor ? 'tick-num major' : 'tick-num');
      t.setAttribute('x', np.x.toFixed(1));
      t.setAttribute('y', (np.y + 3).toFixed(1));
      t.setAttribute('text-anchor', 'middle');
      t.textContent = String(h);
      group.appendChild(t);
    }
  }

  function updateConfHalo(held, band) {
    const halo = document.getElementById('sensed-split-halo');
    if (!halo) return;
    if (band <= 1 || !Number.isFinite(held)) { halo.setAttribute('d', ''); return; }
    const half = band === 2 ? 9 : 18;
    const aMin = heldToAngle(held) - half;
    const aMax = heldToAngle(held) + half;
    const rIn = R - 14, rOut = R + 4;
    const p1 = arcPoint(aMin, rIn), p2 = arcPoint(aMin, rOut);
    const p3 = arcPoint(aMax, rOut), p4 = arcPoint(aMax, rIn);
    const d = `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} A ${rOut} ${rOut} 0 0 1 ${p3.x.toFixed(1)} ${p3.y.toFixed(1)} L ${p4.x.toFixed(1)} ${p4.y.toFixed(1)} A ${rIn} ${rIn} 0 0 0 ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Z`;
    halo.setAttribute('d', d);
  }

  function updateTargetMarker(target) {
    if (!Number.isFinite(target)) return;
    const tri = document.getElementById('sensed-split-target-tri');
    const line = document.getElementById('sensed-split-target-line');
    const a = heldToAngle(target);
    const p = arcPoint(a, R + 6);
    if (tri) tri.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${a.toFixed(2)})`);
    const e = arcPoint(a, R - 12);
    if (line) { line.setAttribute('x2', e.x.toFixed(1)); line.setAttribute('y2', e.y.toFixed(1)); }
  }

  function directionFor(h) {
    if (h >= 7) return 'held-leaning';
    if (h <= 3) return 'conflated-leaning';
    return 'balanced';
  }

  function renderRibbon(perDial) {
    const list = document.getElementById('sensed-split-dial-list');
    if (!list) return;
    if (!Array.isArray(perDial) || perDial.length === 0) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = perDial.map((d) => {
      const v = Number.isFinite(d && d.value) ? d.value : 0;
      const pct = Math.max(0, Math.min(100, v * 100));
      const label = (d && (d.label || d.slug)) ? String(d.label || d.slug).slice(0, 4).toUpperCase() : '·';
      return `
        <div class="ribbon-dial" title="${escapeHtml(d && (d.name || d.label || d.slug) || '')}">
          <div class="ribbon-bar">
            <div class="ribbon-bar-tick"></div>
            <div class="ribbon-bar-fill" style="height: ${pct.toFixed(0)}%"></div>
          </div>
          <div class="ribbon-value">${v.toFixed(2)}</div>
          <div class="ribbon-label">${escapeHtml(label)}</div>
        </div>`;
    }).join('');
  }

  function applyReadout() {
    const h = Math.max(1, Math.min(9, Math.round(state.displayedHeld)));
    setText('sensed-split-held', String(h));
    setText('sensed-split-conf', String(10 - h));
    setText('sensed-split-direction', directionFor(h));
    setText('sensed-split-target-val', `${state.targetTarget}:${10 - state.targetTarget}`);
    setText('sensed-split-band', String(state.band));
  }

  // Settle speed + rest threshold. The dial eases to its reading then STOPS —
  // it does not hold a perpetual rAF loop. The old idle "waver" ran at 60fps
  // forever and competed with chat rendering, which read as lag. Now a new
  // reading or a chat-round pulse wakes the loop; once the needle is at rest
  // the loop releases the frame and nothing animates while you type.
  const EASE = 0.40;        // 0.08 → 0.22 → 0.40: fast, responsive per-chat-round settle
  const SETTLE_EPS = 0.02;

  function wake() {
    if (!state.running) { state.running = true; requestAnimationFrame(loop); }
  }

  function loop() {
    if (!state.running) return;
    const now = performance.now() / 1000;

    // Ease displayed reading toward target.
    state.displayedHeld += (state.targetHeld - state.displayedHeld) * EASE;

    // Wobble is now ONLY the damped chat-round flick — no perpetual idle
    // drift — so the needle can come fully to rest and the loop can stop.
    const pulseAge = now - state.pulseStart;
    const pulse = state.pulseAmp * Math.exp(-pulseAge * 1.8) * Math.sin(pulseAge * 6);

    const angle = heldToAngle(state.displayedHeld) + pulse;
    const ng = document.getElementById('sensed-split-needle-group');
    if (ng) ng.setAttribute('transform', `translate(${CX} ${CY}) rotate(${angle.toFixed(3)})`);

    state._frame = (state._frame || 0) + 1;
    if (state._frame % 6 === 0) applyReadout();

    // Self-terminate once settled and the flick has decayed: snap to the exact
    // resting angle and release the rAF so nothing runs while idle.
    const settled = Math.abs(state.targetHeld - state.displayedHeld) < SETTLE_EPS;
    const pulseDone = Math.abs(pulse) < 0.01 && pulseAge > 2;
    if (settled && pulseDone) {
      state.displayedHeld = state.targetHeld;
      if (ng) ng.setAttribute('transform', `translate(${CX} ${CY}) rotate(${heldToAngle(state.displayedHeld).toFixed(3)})`);
      applyReadout();
      state.running = false;
      return;
    }
    requestAnimationFrame(loop);
  }

  function setSensedSplit(reading) {
    if (!state.initialised) {
      renderTicks();
      state.initialised = true;
    }
    if (typeof reading.held === 'number')   state.targetHeld   = clamp1to9(reading.held);
    if (typeof reading.target === 'number') state.targetTarget = clamp1to9(reading.target);
    if (typeof reading.band === 'number')   state.band         = Math.max(1, Math.min(3, reading.band));
    if (Array.isArray(reading.per_dial)) {
      state.perDial = reading.per_dial.slice();
      renderRibbon(state.perDial);
    }
    if (reading.ratio) state.lastRatio = reading.ratio;
    updateTargetMarker(state.targetTarget);
    updateConfHalo(state.targetHeld, state.band);
    wake(); // animate to the new reading, then the loop stops itself
  }

  function pulseChatRound(intensity) {
    state.pulseStart = performance.now() / 1000;
    state.pulseAmp = (3.5 + Math.random() * 2.5) * (intensity || 1);
    wake(); // a chat-round flick must restart the loop if it had settled
  }

  function reset() {
    state.targetHeld = 5;
    state.displayedHeld = 5;
    state.band = 1;
    state.pulseAmp = 0;
    state.perDial = [];
    state.lastRatio = null;
    renderRibbon([]);
    updateConfHalo(state.targetHeld, state.band);
  }

  function clamp1to9(v) { return Math.max(1, Math.min(9, Number(v) || 5)); }

  return { setSensedSplit, pulseChatRound, reset };
})();

// Public — chat.js calls this on each assistant-response settle.
export function pulseChatRound(intensity) { DIAL.pulseChatRound(intensity); }

// Public — chat.js calls this after each assistant reply with the reply text.
// Reads a LIVE per-turn sensed split (fast, deterministic — no extra LLM
// call) and eases the needle to it, so the dial responds every chat round.
// Calibration remains the baseline; this is the live conversational layer.
export async function applyTurnReading(responseText) {
  if (!isTauri || !responseText) return;
  let reading = null;
  try {
    reading = await SensedSplit.readTurn(responseText);
  } catch (e) {
    console.warn('sensed_split_turn failed', e);
    return;
  }
  if (!reading) return;
  const badge = document.getElementById('sensed-split-badge');
  if (badge) badge.setAttribute('data-state', 'visible');
  DIAL.setSensedSplit({
    held:     reading.held,
    target:   getTargetSplitHeldSync(),
    band:     reading.band,
    per_dial: reading.per_dial,
    ratio:    reading.ratio,
  });
}

async function refreshSensedSplitBadge(fp) {
  const badge = document.getElementById('sensed-split-badge');
  if (!badge) return;

  let reading = null;
  if (isTauri) {
    try {
      reading = await SensedSplit.read(fp);
    } catch (err) {
      console.warn('sensed_split IPC failed:', err);
    }
  }

  if (!reading) {
    // No reading available — flavour declares no split_ratio_mapping,
    // or IPC errored. Flip to awaiting so the Calibrate CTA shows.
    badge.setAttribute('data-state', 'awaiting');
    return;
  }

  // Read the target setting (preference for instant sync read).
  const targetHeld = getTargetSplitHeldSync();

  DIAL.setSensedSplit({
    held:     reading.held,
    target:   targetHeld,
    band:     reading.band,
    per_dial: reading.per_dial,
    ratio:    reading.ratio,
  });

  badge.setAttribute('data-state', 'visible');

  // Background — re-read target from disk in case it changed in Settings.
  if (isTauri) {
    getTargetSplitHeld().then((held) => {
      DIAL.setSensedSplit({ target: held });
    }).catch(() => {});
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// Minimal markdown renderer for narrator output.
// Handles `# heading`, `**bold**`, `*italic*`, `` `code` ``, paragraphs.
// Escapes HTML first so model-supplied content can't inject. Map `#`/`##`
// to `<h4>`/`<h5>` to keep heading scale appropriate inside the panel.
function renderMd(text) {
  if (!text) return '';
  const escaped = escapeHtml(text);
  const lines = escaped.split('\n');
  let html = '';
  let buf = [];

  const flush = () => {
    if (buf.length) {
      const para = buf.join(' ').trim();
      if (para) html += `<p>${formatInline(para)}</p>`;
      buf = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(h[1].length + 3, 6); // # → h4
      html += `<h${level}>${formatInline(h[2])}</h${level}>`;
      continue;
    }
    buf.push(line);
  }
  flush();
  return html;
}

function formatInline(s) {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

// Hydrate from Settings on startup (Tauri runtime).
export async function hydrateFromSettings() {
  if (!isTauri) return;
  try {
    const s = await Settings.get();
    setEnabledClasses(s.enabled_classes || []);
  } catch (_) {}
}
