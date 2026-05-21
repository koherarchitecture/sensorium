// tone-suggestions.js — render suggested-tone cues above the composer.
//
// v0.1.3 first pass. The Rust rules layer derives up to 3 tone cues
// from the current Fingerprint (per-class verdicts + per-probe dial
// averages). This module fetches them on each fingerprint update and
// renders them as a row of non-interactive cues above the composer
// textarea. The cues are coaching reads — they tell the user what
// tone the conversation flow suggests for the next message. There is
// no click; the user composes their own message, picking up the tone
// from the cue.
//
// Cold-start behaviour: the row is hidden when no fingerprint has
// been observed yet. After the first fingerprint, the row appears
// and refreshes on each subsequent update.
//
// Browser-preview behaviour: in non-Tauri runtime the row stays
// hidden because Tones.suggest will throw NotInTauri. That's fine for
// design preview — the empty row is invisible by default.
//
// Open questions for Dhyeya's iteration (see buffer.md v0.1.3):
//   - vocabulary breadth (currently 5 candidates in the Rust layer)
//   - placement (currently above composer; alternative: floating row)
//   - cold-start illustration (currently nothing shows pre-first-probe)
//   - history-replay behaviour (currently re-derives from current fp)
//   - update cadence (currently fires on every fp update; spec
//     suggests every 3 exchanges as a tuning lever)
//   - visual hierarchy between multiple active cues (currently equal
//     weight — system-selected means each is equally relevant)

import { isTauri, Tones } from './ipc.js';

let _hostEl = null;        // .tone-suggestions row

export function init() {
  _hostEl = document.getElementById('tone-suggestions');
  if (_hostEl) {
    _hostEl.setAttribute('data-state', 'cold');
    _hostEl.setAttribute('aria-label', 'Tone the conversation flow suggests for your next message');
  }
}

/// Update the row from a fingerprint. Safe to call before init() —
/// becomes a no-op until the host element resolves.
export async function update(fingerprint) {
  if (!_hostEl) {
    // init() may not have run yet; try to resolve lazily.
    _hostEl = document.getElementById('tone-suggestions');
    if (!_hostEl) return;
  }

  if (!fingerprint || !fingerprint.classes || fingerprint.classes.length === 0) {
    hide();
    return;
  }

  if (!isTauri) {
    // Browser preview: keep row hidden rather than fabricating cues.
    hide();
    return;
  }

  try {
    const suggestions = await Tones.suggest(fingerprint);
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      hide();
      return;
    }
    render(suggestions);
  } catch (err) {
    console.warn('tone-suggestions update failed:', err);
    hide();
  }
}

function render(suggestions) {
  _hostEl.innerHTML = '';
  _hostEl.setAttribute('data-state', 'active');

  for (const s of suggestions) {
    // Non-interactive: use <span>, not <button>. The system selects
    // which cues appear; the user reads them and writes in that tone.
    // Hover tooltip (title=) exposes the trigger reason for the
    // curious without requiring action.
    const cue = document.createElement('span');
    cue.className = 'tone-cue';
    cue.setAttribute('data-tone-key', s.key);
    cue.setAttribute('title', s.trigger || '');
    cue.textContent = s.label;
    _hostEl.appendChild(cue);
  }
}

function hide() {
  if (_hostEl) {
    _hostEl.innerHTML = '';
    _hostEl.setAttribute('data-state', 'cold');
  }
}
