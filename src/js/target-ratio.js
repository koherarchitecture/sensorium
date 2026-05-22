// target-ratio.js — renderer-side target ratio module.
//
// Mirrors the Rust target_ratio module's vocabulary and validation. The
// authoritative persistence is preferences.json on disk via the
// Settings IPC; this module also writes a localStorage mirror so the
// renderer has instant access on launch without waiting for an IPC
// roundtrip, and so browser-preview (no Tauri) can still walk the
// wizard end-to-end.
//
// Vocabulary discipline — canon rule 5:
//   • The noun is "target ratio".
//   • The verb is "work toward".
//   • Never label the value "your split ratio" or "the split ratio" in
//     any UI surface. Those phrases belong to the self-rated register
//     an instrument cannot occupy.

import { isTauri, Settings } from './ipc.js';

const LS_KEY = 'koher.sensorium.targetSplitHeld';

const MIN_HELD = 1;
const MAX_HELD = 9;
const DEFAULT_HELD = 7;

/** Clamp an arbitrary number into the canon's configurable range. */
export function clampHeld(n) {
  if (!Number.isFinite(n)) return DEFAULT_HELD;
  return Math.max(MIN_HELD, Math.min(MAX_HELD, Math.round(n)));
}

/** True iff `n` is an integer in [1, 9]. */
export function isValidHeld(n) {
  return Number.isInteger(n) && n >= MIN_HELD && n <= MAX_HELD;
}

/** Render the held value as a canonical N:M string (e.g., "7:3"). */
export function formatRatio(held) {
  const h = clampHeld(held);
  return `${h}:${10 - h}`;
}

/** Human-readable direction tag — held-leaning / balanced / conflated-leaning. */
export function directionTag(held) {
  const h = clampHeld(held);
  if (h >= 6) return 'held-leaning';
  if (h === 5) return 'balanced';
  return 'conflated-leaning';
}

/**
 * Get the current target split held value.
 *
 * Resolution order:
 *   1. Settings (preferences.json via IPC) when running under Tauri.
 *   2. localStorage mirror — survives reloads in browser preview and
 *      provides an instant value before IPC returns.
 *   3. DEFAULT_HELD (7).
 *
 * Always updates the localStorage mirror to match the authoritative
 * value, so subsequent synchronous reads via `getTargetSplitHeldSync()`
 * see the latest persisted state.
 */
export async function getTargetSplitHeld() {
  if (isTauri) {
    try {
      const s = await Settings.get();
      const held = clampHeld(s && s.target_split_held);
      writeLocalMirror(held);
      return held;
    } catch (_) {
      // Fall through to localStorage on IPC failure.
    }
  }
  return readLocalMirror();
}

/**
 * Synchronous read — for places (slider rendering, badge layout) that
 * need a value immediately without awaiting IPC. Reads only the
 * localStorage mirror. The mirror is updated whenever a successful
 * `getTargetSplitHeld()` or `setTargetSplitHeld()` resolves, so the
 * sync read is stale-tolerant rather than stale-prone.
 */
export function getTargetSplitHeldSync() {
  return readLocalMirror();
}

/**
 * Persist a new target split held value. Writes the localStorage
 * mirror first (instant) and then updates Settings under Tauri.
 *
 * Throws if `held` is not an integer in [1, 9].
 */
export async function setTargetSplitHeld(held) {
  const h = clampHeld(held);
  if (!isValidHeld(h)) {
    throw new Error(`target ratio held must be 1..=9 (got ${held})`);
  }
  writeLocalMirror(h);
  if (isTauri) {
    const s = await Settings.get();
    s.target_split_held = h;
    await Settings.update(s);
  }
  return h;
}

function readLocalMirror() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw == null) return DEFAULT_HELD;
    const n = parseInt(raw, 10);
    return isValidHeld(n) ? n : DEFAULT_HELD;
  } catch (_) {
    return DEFAULT_HELD;
  }
}

function writeLocalMirror(held) {
  try {
    localStorage.setItem(LS_KEY, String(clampHeld(held)));
  } catch (_) {
    // localStorage may be disabled; the IPC path remains authoritative.
  }
}
