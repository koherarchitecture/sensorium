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
  const refreshBtn = document.querySelector('[data-action="refresh"]');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refresh);
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

  // Hide sensed-split badge — same reason as the tone-cues row.
  const badge = document.getElementById('sensed-split-badge');
  if (badge) badge.setAttribute('data-state', 'hidden');
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
  const btn = document.querySelector('[data-action="refresh"]');
  if (btn) btn.setAttribute('data-state', 'running');
  try {
    const fp = await Calibration.fullRefresh();
    applyFingerprint(fp);
    // After a refresh, usage on the OpenRouter key has changed.
    // Best-effort update of the usage line; failures stay quiet.
    import('./usage-line.js')
      .then((m) => m.refresh(true))
      .catch(() => { /* non-fatal */ });
  } catch (err) {
    // Don't blow up the UI on a refresh failure — the runner errors are
    // expected until ipc::run_full_refresh is wired through to the
    // probes runner. Once it lands, surface the error in the panel
    // header rather than the connection-status strip.
    // eslint-disable-next-line no-console
    console.warn('refresh failed', err);
  } finally {
    if (btn) btn.removeAttribute('data-state');
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
    badge.setAttribute('data-state', 'hidden');
    return;
  }

  // Marker position: held ∈ [1, 9] maps to track position [10%, 90%].
  // (The track endpoints are visually pinned to "held"/"conflated"
  // labels — the canon-excluded 0/10 positions don't appear on screen.)
  const markerPct = sensedSplitTrackPercent(reading.held);
  const targetHeld = getTargetSplitHeldSync();
  const targetPct = sensedSplitTrackPercent(targetHeld);

  setText('sensed-split-ratio', reading.ratio || '—:—');
  setText('sensed-split-direction', reading.direction || '—');
  setText('sensed-split-band', `band ±${reading.band ?? '—'}`);
  setText('sensed-split-summary', reading.verdict_summary || '—');

  const marker = document.getElementById('sensed-split-marker');
  if (marker) marker.style.left = `${markerPct}%`;
  const target = document.getElementById('sensed-split-target');
  if (target) target.style.left = `${targetPct}%`;

  // Per-dial breakdown — gridded dt / dial-track / dial-value triplets.
  const dialList = document.getElementById('sensed-split-dial-list');
  if (dialList) {
    const dials = Array.isArray(reading.per_dial) ? reading.per_dial : [];
    if (dials.length === 0) {
      dialList.innerHTML = '';
      const details = document.getElementById('sensed-split-dials');
      if (details) details.style.display = 'none';
    } else {
      const details = document.getElementById('sensed-split-dials');
      if (details) details.style.display = '';
      dialList.innerHTML = dials.map((d) => {
        const pct = Math.max(0, Math.min(100, (d.value || 0) * 100));
        return `
          <dt>${escapeHtml(d.label || d.slug)}</dt>
          <dd class="dial-track"><div class="dial-fill" style="width: ${pct.toFixed(0)}%"></div></dd>
          <dd class="dial-value">${pct.toFixed(0)}%</dd>
        `;
      }).join('');
    }
  }

  badge.setAttribute('data-state', 'visible');

  // Re-read the target from disk in the background — covers the case
  // where the user changed the target in Settings between renders. The
  // marker position only updates on the next fingerprint refresh, which
  // is fine: the badge is a fingerprint-driven surface.
  if (isTauri) {
    getTargetSplitHeld().then((held) => {
      const t = document.getElementById('sensed-split-target');
      if (t) t.style.left = `${sensedSplitTrackPercent(held)}%`;
    }).catch(() => {});
  }
}

function sensedSplitTrackPercent(held) {
  const h = Math.max(1, Math.min(9, Number(held) || 5));
  // [1, 9] → [10%, 90%]: each step of held is 10% along the track.
  return h * 10;
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
