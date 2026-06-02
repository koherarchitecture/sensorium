// baseline.rs — persist the last calibration Fingerprint to disk.
//
// The app must never present an uncalibrated chat (the first-run wizard's
// calibration is the precondition for the chat screen). Calibration was
// previously in-memory only, so every cold start was effectively
// uncalibrated. Persisting the Fingerprint here lets the frontend confirm,
// at boot, that a real calibration exists for the active model — and re-run
// the wizard's calibration if it does not.
//
// Mirrors settings.rs's disk persistence: same app_config_dir resolution
// (correct under flatpak sandboxes, macOS, and Linux), failures logged not
// propagated, a corrupt/missing file simply reads as "not calibrated".

use crate::schema::Fingerprint;
use std::path::PathBuf;
use tauri::Manager;

const BASELINE_FILENAME: &str = "baseline.json";

/// Absolute path to `baseline.json` for this install.
pub fn baseline_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    Ok(dir.join(BASELINE_FILENAME))
}

/// Load the persisted fingerprint, or `None` if absent/unreadable.
pub fn load_from_disk<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Fingerprint> {
    let path = match baseline_path(app) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("could not resolve baseline path: {e}");
            return None;
        }
    };
    if !path.exists() {
        return None;
    }
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Fingerprint>(&raw) {
            Ok(fp) => Some(fp),
            Err(e) => {
                tracing::warn!("baseline at {} unreadable ({e}) — treating as uncalibrated", path.display());
                None
            }
        },
        Err(e) => {
            tracing::warn!("failed to read {} ({e}) — treating as uncalibrated", path.display());
            None
        }
    }
}

/// Persist a fingerprint to disk. Creates the config dir if missing.
pub fn save_to_disk<R: tauri::Runtime>(app: &tauri::AppHandle<R>, fp: &Fingerprint) -> Result<(), String> {
    let path = baseline_path(app).map_err(|e| format!("resolve baseline path: {e}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create config dir {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(fp).map_err(|e| format!("serialise fingerprint: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))?;
    tracing::debug!("saved baseline to {}", path.display());
    Ok(())
}
