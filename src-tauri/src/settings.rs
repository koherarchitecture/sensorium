// preferences.json — persisted in the user-data directory.
// Schema mirrors spec §12.1.
//
// 7 May 2026 — flavour reframe: `enabled_classes` is removed. With the
// flavour model, all categories defined by the active flavour are run;
// per-category opt-in returns in a future version if needed. The new
// `active_flavour` field names the flavour the engine loads at startup.

use crate::schema::NarrationMode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub version: u32,
    pub active_model: String,
    pub ollama_model: String,
    pub calibration_on_every_session: bool,
    pub filter_cartography_refresh_hours: u32,
    pub filter_cartography_budget_usd: f64,
    pub workflow_capture_enabled: bool,
    pub narration_mode: NarrationMode,
    pub narrator_temperature: f32,
    pub probe_max_tokens: HashMap<String, u32>,
    /// Slug of the active flavour. The engine loads
    /// `flavours/<active_flavour>.json` at startup.
    /// Default at first run: `"sycophancy"`.
    pub active_flavour: String,
    /// Set after first successful Ollama detection — prevents the
    /// install-help banner from showing on every launch.
    pub ollama_setup_complete: bool,
    /// Set after the first-run flow has been completed. Until true,
    /// the renderer shows the first-run wizard on launch.
    pub first_run_complete: bool,
    /// Per-axis probe selection. Maps category-slug → probe-name (must
    /// match a `name` in the active flavour) or the literal `"random"`.
    /// Missing entries default to random.
    #[serde(default)]
    pub probe_selection: HashMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        let mut pmt = HashMap::new();
        pmt.insert("raw".into(), 150);
        pmt.insert("economical".into(), 200);
        pmt.insert("functional".into(), 300);
        pmt.insert("robust".into(), 500);

        Self {
            version: 1,
            active_model: "anthropic/claude-sonnet-4.6".into(),
            ollama_model: "qwen2.5:7b".into(),
            calibration_on_every_session: true,
            filter_cartography_refresh_hours: 24,
            filter_cartography_budget_usd: 0.50,
            workflow_capture_enabled: true,
            narration_mode: NarrationMode::Functional,
            narrator_temperature: 0.0,
            probe_max_tokens: pmt,
            active_flavour: crate::flavour::DEFAULT_FLAVOUR_SLUG.to_string(),
            ollama_setup_complete: false,
            first_run_complete: false,
            probe_selection: HashMap::new(),
        }
    }
}

impl Settings {
    /// Validate that an active flavour is named.
    pub fn validate(&self) -> Result<(), String> {
        if self.active_flavour.is_empty() {
            return Err("active_flavour must be set".into());
        }
        Ok(())
    }
}

// ── Disk persistence (preferences.json under app config dir) ─────────
//
// Path resolution uses Tauri's `app_config_dir()` so it works correctly
// inside flatpak sandboxes (`~/.var/app/app.koher.sensorium/config/...`)
// and on both macOS (`~/Library/Application Support/...`) and Linux
// (`~/.config/...`).

use std::path::PathBuf;
use tauri::Manager;

const PREFS_FILENAME: &str = "preferences.json";

/// Resolve the absolute path to `preferences.json` for this install.
pub fn prefs_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    Ok(dir.join(PREFS_FILENAME))
}

/// Load settings from disk. Returns `Settings::default()` (with the dev
/// defaults applied by the caller, if any) when the file is missing or
/// unreadable; errors are logged, never propagated, so a corrupt file
/// never blocks the app from launching.
pub fn load_from_disk<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Settings {
    let path = match prefs_path(app) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("could not resolve preferences path: {e}");
            return Settings::default();
        }
    };
    if !path.exists() {
        tracing::info!("no preferences file at {} — using defaults", path.display());
        return Settings::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Settings>(&raw) {
            Ok(s) => {
                tracing::info!("loaded preferences from {}", path.display());
                s
            }
            Err(e) => {
                tracing::warn!(
                    "preferences file at {} unreadable ({e}) — using defaults",
                    path.display()
                );
                Settings::default()
            }
        },
        Err(e) => {
            tracing::warn!("failed to read {} ({e}) — using defaults", path.display());
            Settings::default()
        }
    }
}

/// Persist settings to disk. Creates the config dir if missing.
pub fn save_to_disk<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    settings: &Settings,
) -> Result<(), String> {
    let path = prefs_path(app).map_err(|e| format!("resolve prefs path: {e}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create config dir {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("serialise settings: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))?;
    tracing::debug!("saved preferences to {}", path.display());
    Ok(())
}
