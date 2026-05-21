// app.js — top-level orchestrator.
//
// Wires the renderer modules together. Order matters:
//   1. UI primitives (rows, dropdown, modals) — pure DOM, no IPC.
//   2. First-run wizard — gates panel functionality on first launch.
//   3. Filter panel + chat — populated by IPC after first-run completes.
//
// In Tauri runtime everything talks to the Rust core via IPC. In browser
// preview the modules degrade gracefully and leave the static sample
// content in place.

import * as rows from './rows.js';
import * as modeDropdown from './mode-dropdown.js';
import * as probesModal from './probes-modal.js';
import * as firstRun from './first-run.js';
import * as settingsModal from './settings-modal.js';
import * as filterPanel from './filter-panel.js';
import * as categoryVis from './category-vis.js';
import * as chat from './chat.js';
import * as sidebar from './sidebar.js';
import * as toneSuggestions from './tone-suggestions.js';
import { setOllama, setOpenRouter } from './calibration-strip.js';
import { isTauri, Settings, Ollama, ApiKey } from './ipc.js';

async function boot() {
  // Static UI behaviour first — these don't depend on IPC.
  rows.init();
  probesModal.init();
  filterPanel.init();
  toneSuggestions.init();
  // Category icons + per-row verdict strip + per-probe word bar.
  // Renders from the static HTML preview content so visualisations
  // are visible before any backend call lands. updateFromFingerprint
  // refreshes from real data.
  categoryVis.init();
  modeDropdown.init({
    onChange: (mode) => {
      // Mode change re-quantifies the cost ladder; the panel visually
      // reflects this through the data-mode attribute. Persistence to
      // Settings is a v0.2 concern — for v0.1 the change is local until
      // the user opens Settings and saves.
      void mode;
    },
  });

  // Settings modal — opens from titlebar, persists through IPC.
  settingsModal.init({
    onChanged: ({ enabledClasses, activeModel: nextModel }) => {
      filterPanel.setEnabledClasses(enabledClasses);
      if (nextModel) {
        chat.setModel(nextModel);
        updateHeaderModel(nextModel);
      }
    },
  });

  // Chat — wired regardless of first-run state so the static preview
  // remains interactive even before calibration completes. The active
  // model is read from settings if available.
  let activeModel = 'anthropic/claude-sonnet-4.6';
  if (isTauri) {
    try {
      const s = await Settings.get();
      if (s && s.active_model) activeModel = s.active_model;
    } catch (_) {}
  }
  updateHeaderModel(activeModel);
  await chat.init({ model: activeModel });

  // Conversations sidebar — wires the drawer toggle, the search input,
  // and the listener that auto-refreshes the list when chat.js saves
  // a new exchange. Must come after chat.init() because sidebar imports
  // chat.onConversationChange / loadConversation / currentConversationId.
  await sidebar.init();

  // First-run wizard. On completion it hands back the chosen classes
  // (and a Fingerprint, if calibration succeeded) so the panel can
  // populate immediately without a second round-trip.
  await firstRun.init({
    onComplete: async ({ enabledClasses, fingerprint }) => {
      if (enabledClasses && enabledClasses.length) {
        filterPanel.setEnabledClasses(enabledClasses);
      }
      if (fingerprint) {
        filterPanel.applyFingerprint(fingerprint);
      } else if (isTauri) {
        // Wizard reached "finish" without a fingerprint (e.g. retry
        // skipped) — try a calibration pass now so the panel isn't
        // empty. If this also fails, the static sample remains.
        await filterPanel.calibrate();
      }
      // Caret moves to the composer once the wizard finishes.
      chat.focusInput();
    },
  });

  // If first-run was previously completed, populate the panel from
  // saved settings + run a refresh in the background.
  if (isTauri) {
    await filterPanel.hydrateFromSettings();
    // Don't auto-refresh on every launch in v0.1 — settings.calibration_on_every_session
    // controls this; the runner is not yet wired so a refresh would error.
    // Once ipc::run_calibration is implemented, gate this on the setting.

    // Strip indicators (OLLAMA, OPENROUTER) — initial poll. The strip
    // ships with hardcoded placeholders in the HTML; without this call
    // it will display them forever.
    refreshStripState();
    // Re-poll periodically so reachability changes (Ollama daemon
    // stopped, key cleared) become visible without a manual reload.
    setInterval(refreshStripState, 30 * 1000);
  }
}

// Mirror the saved active_model into the titlebar `.model-pick` badge.
// The header ships with hardcoded "anthropic / claude-sonnet-4.6" — this
// rewrites it from settings so the badge tells the truth about which
// model the chat module will actually send to. The display format inserts
// spaces around the slash to match the header typography.
function updateHeaderModel(model) {
  if (!model) return;
  const el = document.getElementById('header-model-value');
  if (!el) return;
  el.textContent = String(model).replace('/', ' / ');
}

async function refreshStripState() {
  try {
    const status = await Ollama.status();
    setOllama(status);
  } catch (_) { /* leave previous state */ }
  try {
    const has = await ApiKey.has();
    setOpenRouter(!!has);
  } catch (_) { /* leave previous state */ }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
