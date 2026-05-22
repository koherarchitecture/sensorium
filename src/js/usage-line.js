// usage-line.js — OpenRouter spend display (Dhyeya #10, v0.1.6).
//
// Shows the user's own cumulative spend on the OpenRouter key, with
// limit when one is set. Surfaced next to the static "~$0.18 next
// refresh" estimate so the user sees both the per-refresh cost and
// the running total. Telemetry-not-introspection: the position is
// about the model's behaviour; the user's own credit consumption is
// fair to surface.
//
// Refresh strategy: on boot (if API key is set), after each
// calibration, and on demand when the user opens Settings. The
// IPC fails soft — no key set or network down leaves the row in
// its cold state ("—").

import { isTauri, Provider, ApiKey } from './ipc.js';

let _lastFetchAt = 0;
const MIN_REFETCH_MS = 15000;  // throttle to one call per ~15s

function fmtUsd(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  return '$' + n.toFixed(2);
}

function setState(state) {
  const el = document.getElementById('openrouter-usage-line');
  if (el) el.setAttribute('data-state', state);
}

function setText(text, suffix) {
  const val = document.getElementById('openrouter-usage-val');
  if (val) val.textContent = text;
  if (suffix !== undefined) {
    const sfx = document.querySelector('#openrouter-usage-line .usage-suffix');
    if (sfx) sfx.textContent = suffix;
  }
}

/// Fetch the OpenRouter usage and update the row. No-op outside Tauri.
/// `force` bypasses the throttle (called manually from refresh-button
/// or settings-save paths).
export async function refresh(force) {
  if (!isTauri) return;
  const now = Date.now();
  if (!force && now - _lastFetchAt < MIN_REFETCH_MS) return;

  // Gate on having an API key set — otherwise Provider.usage() returns
  // "OpenRouter key not set" and we'd flash an error in the UI.
  try {
    const has = await ApiKey.has();
    if (!has) {
      setState('cold');
      setText('—', 'API key not set');
      return;
    }
  } catch (_) { /* fall through */ }

  _lastFetchAt = now;
  try {
    const info = await Provider.usage();
    if (!info) {
      setState('cold');
      return;
    }
    const used = fmtUsd(info.usage);
    const suffix = (typeof info.limit === 'number' && info.limit > 0)
      ? `of ${fmtUsd(info.limit)} limit`
      : (info.is_free_tier ? 'on free-tier key' : 'spent on key');
    setText(used, suffix);
    setState('loaded');
  } catch (err) {
    console.warn('openrouter usage fetch failed:', err);
    setState('error');
    setText('—', 'usage check failed');
  }
}

export function init() {
  // Background fetch on boot; failures stay silent (cold state).
  setTimeout(() => refresh(true).catch(() => {}), 1200);
}
