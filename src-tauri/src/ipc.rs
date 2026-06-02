// IPC commands — the renderer's only contact with the Rust core.
//
// Each #[tauri::command] is registered in lib.rs::run().
// State is passed via tauri::State<AppState>.

use crate::probes::runner::{self, RunnerConfig};
use crate::providers::{ChatMessageInput, ChatOpts, OpenRouterClient};
use crate::schema::{Fingerprint, WorkflowState};
use crate::system_info::{self, OllamaRecommendation, SystemInfo};
use crate::{keychain, narrator, ollama, settings, AppState};
use serde::Deserialize;
use std::sync::Arc;
use tauri::{Emitter, State, Window};

// ── System / first-run setup ──────────────────────────────────────

#[tauri::command]
pub fn system_info() -> SystemInfo {
    system_info::capture()
}

#[tauri::command]
pub fn recommend_ollama_model() -> OllamaRecommendation {
    let info = system_info::capture();
    system_info::recommend_ollama(&info)
}

// ── Settings ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<settings::Settings, String> {
    let s = state.settings.read().await.clone();
    Ok(s)
}

#[tauri::command]
pub async fn update_settings(
    app: tauri::AppHandle,
    new: settings::Settings,
    state: State<'_, AppState>,
) -> Result<(), String> {
    new.validate()?;
    {
        let mut s = state.settings.write().await;
        *s = new.clone();
    }
    // Persist to <app_config>/preferences.json. Failure is logged but
    // does not fail the IPC call — settings still apply in-memory.
    if let Err(e) = settings::save_to_disk(&app, &new) {
        tracing::warn!("failed to persist settings: {e}");
    }
    Ok(())
}

// ── API key ───────────────────────────────────────────────────────

fn config_dir_of(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().ok()
}

#[tauri::command]
pub async fn has_api_key(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if state.openrouter_key.read().await.is_some() {
        return Ok(true);
    }
    let dir = config_dir_of(&app);
    match keychain::get_openrouter_key(dir.as_deref()) {
        Ok(Some(k)) => {
            *state.openrouter_key.write().await = Some(k);
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(e) => Err(format!("keychain error: {e}")),
    }
}

#[tauri::command]
pub async fn set_api_key(
    app: tauri::AppHandle,
    key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let dir = config_dir_of(&app);
    keychain::set_openrouter_key(&key, dir.as_deref()).map_err(|e| e.to_string())?;
    *state.openrouter_key.write().await = Some(key);
    Ok(())
}

#[tauri::command]
pub async fn clear_api_key(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let dir = config_dir_of(&app);
    keychain::clear_openrouter_key(dir.as_deref()).map_err(|e| e.to_string())?;
    *state.openrouter_key.write().await = None;
    Ok(())
}

// ── Provider models ───────────────────────────────────────────────

#[tauri::command]
pub async fn list_models(
    state: State<'_, AppState>,
) -> Result<Vec<crate::providers::ModelInfo>, String> {
    let key = state
        .openrouter_key
        .read()
        .await
        .clone()
        .ok_or_else(|| "OpenRouter key not set".to_string())?;
    let client = OpenRouterClient::new(key);
    let models = client.list_models().await.map_err(|e| e.to_string())?;
    // Side-effect: populate the per-model pricing cache so streamed
    // chat can compute cost without a network round-trip per call.
    {
        let mut cache = state.pricing_cache.write().await;
        for m in &models {
            if let (Some(p_in), Some(p_out)) = (m.pricing_in, m.pricing_out) {
                cache.insert(m.id.clone(), (p_in, p_out));
            }
        }
    }
    Ok(models)
}

// ── Ollama status ─────────────────────────────────────────────────

#[tauri::command]
pub async fn ollama_status(state: State<'_, AppState>) -> Result<ollama::OllamaStatus, String> {
    let model = state.settings.read().await.ollama_model.clone();
    let client = ollama::OllamaClient::new(&model);
    Ok(client.status(&model).await)
}

/// Pull an Ollama model from the registry, streaming progress events
/// to the renderer. Each NDJSON line from `/api/pull` is forwarded as
/// an `ollama-pull-progress` event with payload `{status, digest?,
/// total?, completed?, error?}`. Returns when the pull reaches
/// `status: "success"` (or errors).
#[tauri::command]
pub async fn ollama_pull(window: Window, model: String) -> Result<(), String> {
    tracing::info!("ollama_pull invoked: model={}", model);

    if model.trim().is_empty() {
        return Err("model tag must not be empty".to_string());
    }

    let client = ollama::OllamaClient::new(&model);
    let win = window.clone();

    let result = client
        .pull_model_stream(&model, move |progress| {
            tracing::info!(
                "pull progress: status={} completed={:?} total={:?}",
                progress.status,
                progress.completed,
                progress.total
            );
            match win.emit("ollama-pull-progress", &progress) {
                Ok(()) => {}
                Err(e) => tracing::warn!("emit ollama-pull-progress failed: {e}"),
            }
        })
        .await;

    match result {
        Ok(()) => {
            tracing::info!("ollama_pull completed: model={}", model);
            Ok(())
        }
        Err(e) => {
            tracing::error!("ollama_pull failed: {}", e);
            Err(format!("ollama pull failed: {e}"))
        }
    }
}

// ── Calibration / refresh ─────────────────────────────────────────

#[tauri::command]
pub async fn run_calibration(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Fingerprint, String> {
    let fp = run_probes(&state, /* thin_mode = */ true).await?;
    // Persist so the app can confirm at boot that a real calibration exists
    // (the "no uncalibrated chat" invariant). Failure is logged, not fatal.
    tracing::info!(
        "run_calibration: probes complete, classes={} total_probes={}",
        fp.classes.len(),
        fp.total_probes
    );
    match crate::baseline::save_to_disk(&app, &fp) {
        Ok(()) => tracing::info!("run_calibration: baseline persisted"),
        Err(e) => tracing::warn!("run_calibration: failed to persist baseline: {e}"),
    }
    Ok(fp)
}

#[tauri::command]
pub async fn run_full_refresh(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Fingerprint, String> {
    let fp = run_probes(&state, /* thin_mode = */ false).await?;
    if let Err(e) = crate::baseline::save_to_disk(&app, &fp) {
        tracing::warn!("failed to persist baseline: {e}");
    }
    Ok(fp)
}

/// Return the persisted calibration fingerprint, or `None` if the app has
/// never successfully calibrated (or the file is unreadable). The frontend
/// uses this at boot to decide whether the chat may load or the wizard's
/// calibration must run again.
///
/// Flavour-staleness guard (v0.1.7): a baseline written for an older flavour
/// definition still parses cleanly after an upgrade, which would leave the
/// chat reading a plausible-but-wrong sensed split with no signal to the
/// user. So we compare the baseline's `probe_set_version` (which is
/// `"{slug}-v{flavour_version}"`, set in `probes/runner.rs`) against the
/// active flavour's identity. On mismatch the baseline is stale: return
/// `None` so the wizard re-runs and recalibrates — the same recovery path as
/// a missing/unreadable file. Bumping `flavour_version` in a flavour JSON
/// after changing its classes or split-ratio mapping therefore auto-
/// invalidates every old baseline. When no flavour is loaded we cannot
/// compare, so the baseline is returned unguarded.
#[tauri::command]
pub async fn get_fingerprint(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Fingerprint>, String> {
    let fp = match crate::baseline::load_from_disk(&app) {
        Some(fp) => fp,
        None => return Ok(None),
    };
    if let Some(flv) = state.flavour.read().await.as_ref() {
        let current = format!("{}-v{}", flv.slug, flv.flavour_version);
        if fp.probe_set_version != current {
            tracing::info!(
                "get_fingerprint: baseline stale (probe_set_version {:?} != current {:?}) — treating as uncalibrated",
                fp.probe_set_version,
                current
            );
            return Ok(None);
        }
    }
    Ok(Some(fp))
}

async fn run_probes(state: &State<'_, AppState>, thin_mode: bool) -> Result<Fingerprint, String> {
    // Snapshot settings + key under read locks (don't hold across the long-running run).
    let settings = state.settings.read().await.clone();
    settings.validate().map_err(|e| e.to_string())?;

    let key = state
        .openrouter_key
        .read()
        .await
        .clone()
        .ok_or_else(|| "OpenRouter key not set".to_string())?;

    let openrouter = OpenRouterClient::new(key);
    let ollama = ollama::OllamaClient::new(&settings.ollama_model);

    // Resolve the active flavour from state. If absent, we cannot run
    // probes — the engine is flavour-driven from v0.1 onward.
    let flavour_cfg = state
        .flavour
        .read()
        .await
        .clone()
        .ok_or_else(|| "no flavour loaded — install a flavour config first".to_string())?;

    let cfg = RunnerConfig {
        model: settings.active_model.clone(),
        mode: settings.narration_mode,
        budget_usd: settings.filter_cartography_budget_usd,
        thin_mode,
        flavour: flavour_cfg,
        probe_selection: settings.probe_selection.clone(),
    };

    let mut fingerprint = if thin_mode {
        runner::run_calibration(cfg, &openrouter, &ollama)
            .await
            .map_err(|e| format!("calibration failed: {e}"))?
    } else {
        runner::run_full_refresh(cfg, &openrouter, &ollama)
            .await
            .map_err(|e| format!("refresh failed: {e}"))?
    };

    // Pass the fingerprint through the narrator to fill the reading
    // field. Narration is best-effort: if it fails we still return the
    // fingerprint with no reading rather than failing the whole call.
    match narrator::narrate(&fingerprint, settings.narration_mode, &openrouter).await {
        Ok(reading) => {
            fingerprint.reading = reading;
        }
        Err(e) => {
            tracing::warn!("narrator failed (returning fingerprint without reading): {e}");
        }
    }

    Ok(fingerprint)
}

// ── Chat ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

#[tauri::command]
pub async fn send_chat_message(
    window: Window,
    model: String,
    messages: Vec<ChatTurn>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let key = state
        .openrouter_key
        .read()
        .await
        .clone()
        .ok_or_else(|| "OpenRouter key not set".to_string())?;

    let client = OpenRouterClient::new(key);

    let inputs: Vec<ChatMessageInput> = messages
        .into_iter()
        .map(|m| ChatMessageInput { role: m.role, content: m.content })
        .collect();

    if inputs.is_empty() {
        return Err("messages must contain at least one turn".to_string());
    }

    // Clone the window so the streaming closure outlives this future's
    // borrow. Tauri's Window is cheaply cloneable (it wraps an Arc).
    let win = window.clone();

    let result = client
        .chat_stream(
            &model,
            &inputs,
            ChatOpts::default(),
            move |chunk| {
                // Best-effort emit; if the renderer side has unmounted
                // we don't want to abort the stream.
                let _ = win.emit("chat-chunk", chunk);
            },
        )
        .await
        .map_err(|e| format!("chat stream failed: {e}"))?;

    // OpenRouter's SSE stream does not include `usage.cost`; compute
    // from the per-model pricing cache populated by `list_models`. Cost
    // is logged for operator visibility (commodity telemetry per spec
    // §17 — not surfaced to the user). If the cache lacks pricing for
    // this model, log a hint and skip.
    {
        let cache = state.pricing_cache.read().await;
        match cache.get(&model) {
            Some((p_in, p_out)) => {
                let cost_usd =
                    (result.tokens_in as f64) * p_in + (result.tokens_out as f64) * p_out;
                tracing::info!(
                    "chat cost {model}: in={} out={} cost=${:.6}",
                    result.tokens_in,
                    result.tokens_out,
                    cost_usd
                );
            }
            None => {
                tracing::debug!(
                    "no pricing cached for {model}; call list_models to populate the cache"
                );
            }
        }
    }

    Ok(result.text)
}

// ── Probe set transparency ────────────────────────────────────────

#[tauri::command]
pub async fn get_probe_set(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cfg = state
        .flavour
        .read()
        .await
        .clone()
        .ok_or_else(|| "no flavour loaded".to_string())?;
    Ok(crate::probes::probe_bank(&cfg))
}

// ── Flavour management ────────────────────────────────────────────

/// Seed the active flavour into user-data on first run, then reload.
///
/// The flavour file ships bundled inside the app at
/// `<bundle-resources>/flavours/<slug>.json`. On first run the wizard
/// calls this command so the file is copied to
/// `<user-data>/flavours/<slug>.json` — making it user-editable and
/// available even when the dev-fallback path doesn't apply (installed
/// .deb / .flatpak / .dmg builds do not have a working-directory
/// `flavours/` folder; only `cargo tauri dev` does).
///
/// Idempotent: returns `Ok(())` without re-copying when the user-data
/// file already exists.
#[tauri::command]
pub async fn seed_active_flavour(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use tauri::Manager;

    let slug = state.settings.read().await.active_flavour.clone();

    let user_data_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve user data dir: {e}"))?;
    let bundle_resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resolve bundle resource dir: {e}"))?;

    crate::flavour::ensure_flavour_in_user_data(&slug, &user_data_dir, &bundle_resource_dir)
        .map_err(|e| format!("seed flavour '{slug}': {e}"))?;

    // Reload the in-memory flavour from disk so the engine immediately
    // uses the just-seeded copy (the loader prefers user-data over bundle).
    match crate::flavour::load_flavour(&slug, Some(&user_data_dir), Some(&bundle_resource_dir)) {
        Ok(cfg) => {
            *state.flavour.write().await = Some(cfg);
            Ok(())
        }
        Err(e) => Err(format!("reload flavour '{slug}' after seed: {e}")),
    }
}

// ── OpenRouter usage (v0.1.6, Dhyeya #10) ─────────────────────────
//
// Surfaces the user's own spend on their OpenRouter key. Telemetry-
// not-introspection: the position is about the model's behaviour; the
// user's own credit consumption is fair game to display. Read on
// settings-modal open and after each calibration refresh; the JS side
// caches between calls.

#[tauri::command]
pub async fn openrouter_usage(
    state: State<'_, AppState>,
) -> Result<crate::providers::UsageInfo, String> {
    let key = state
        .openrouter_key
        .read()
        .await
        .clone()
        .ok_or_else(|| "OpenRouter key not set".to_string())?;
    let client = OpenRouterClient::new(key);
    client.usage().await.map_err(|e| e.to_string())
}

// ── Flavour install (v0.1.6) ──────────────────────────────────────
//
// Two install pathways + browse-registry helper. Both pathways validate
// the JSON, write to user-data, activate as the new active flavour, and
// reload the in-memory state.flavour so the next calibration uses the
// new probe bank without an app restart.

const FLAVOUR_FETCH_MAX_BYTES: usize = 1_000_000; // 1 MB ceiling
const FLAVOUR_FETCH_TIMEOUT_SECS: u64 = 30;

async fn activate_flavour_after_install(
    cfg: &crate::schema::FlavourConfig,
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    use tauri::Manager;

    let user_data_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve user data dir: {e}"))?;
    let bundle_resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resolve bundle resource dir: {e}"))?;

    let loaded = crate::flavour::load_flavour(
        &cfg.slug,
        Some(&user_data_dir),
        Some(&bundle_resource_dir),
    )
    .map_err(|e| format!("reload installed flavour '{}': {e}", cfg.slug))?;

    // Persist active_flavour to settings + write to disk.
    let s_clone = {
        let mut s = state.settings.write().await;
        s.active_flavour = cfg.slug.clone();
        s.clone()
    };
    settings::save_to_disk(app, &s_clone)
        .map_err(|e| format!("persist active_flavour: {e}"))?;

    *state.flavour.write().await = Some(loaded);
    Ok(())
}

#[tauri::command]
pub async fn install_flavour_from_url(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    use tauri::Manager;

    if url.trim().is_empty() {
        return Err("URL is empty".into());
    }
    let trimmed = url.trim();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("URL must start with http:// or https://".into());
    }

    let user_data_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve user data dir: {e}"))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(FLAVOUR_FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("build http client: {e}"))?;

    let resp = client
        .get(trimmed)
        .send()
        .await
        .map_err(|e| format!("fetch flavour from {trimmed}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "flavour fetch returned HTTP {}",
            resp.status().as_u16()
        ));
    }

    // Bounded read — bail if the server tries to send something huge.
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read response body: {e}"))?;
    if bytes.len() > FLAVOUR_FETCH_MAX_BYTES {
        return Err(format!(
            "flavour file is {} bytes; ceiling is {} bytes",
            bytes.len(),
            FLAVOUR_FETCH_MAX_BYTES
        ));
    }

    let cfg = crate::flavour::install_flavour_from_bytes(&bytes, &user_data_dir)
        .map_err(|e| format!("install flavour: {e}"))?;

    activate_flavour_after_install(&cfg, &app, &state).await?;
    Ok(cfg.slug)
}

#[tauri::command]
pub async fn install_flavour_from_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Flavour JSON", &["json"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = tokio::task::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| format!("dialog wait: {e}"))?
        .map_err(|e| format!("dialog channel: {e}"))?;

    let Some(file_path) = picked else {
        // User cancelled — not an error.
        return Ok(None);
    };

    let path_buf = file_path
        .into_path()
        .map_err(|e| format!("resolve picked path: {e}"))?;

    let bytes = std::fs::read(&path_buf)
        .map_err(|e| format!("read flavour file at {}: {e}", path_buf.display()))?;
    if bytes.len() > FLAVOUR_FETCH_MAX_BYTES {
        return Err(format!(
            "flavour file is {} bytes; ceiling is {} bytes",
            bytes.len(),
            FLAVOUR_FETCH_MAX_BYTES
        ));
    }

    let user_data_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve user data dir: {e}"))?;
    let cfg = crate::flavour::install_flavour_from_bytes(&bytes, &user_data_dir)
        .map_err(|e| format!("install flavour: {e}"))?;

    activate_flavour_after_install(&cfg, &app, &state).await?;
    Ok(Some(cfg.slug))
}

#[tauri::command]
pub async fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    if url.trim().is_empty() {
        return Err("URL is empty".into());
    }
    let trimmed = url.trim();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("URL must start with http:// or https://".into());
    }
    app.shell()
        .open(trimmed, None)
        .map_err(|e| format!("open external URL: {e}"))
}

// ── Workflow ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_workflow() -> Result<WorkflowState, String> {
    Ok(crate::workflow::current())
}

#[tauri::command]
pub async fn clear_workflow() -> Result<(), String> {
    crate::workflow::clear();
    Ok(())
}

// ── Conversations: append-only persistence + retrieval ────────────
//
// All five commands resolve <app_config>/conversations/ at call time via
// the AppHandle so the right path is used in dev (cwd-relative on
// Linux), in flatpak (sandboxed ~/.var/app/...), and in macOS (app
// support dir). They fail soft: errors propagate to the renderer which
// logs without breaking the chat flow (the chat in renderer state
// remains the source of truth for the active session).

#[tauri::command]
pub async fn save_exchange(
    app: tauri::AppHandle,
    conversation_id: String,
    exchange: crate::conversations::StoredExchange,
) -> Result<(), String> {
    let dir = config_dir_of(&app).ok_or_else(|| "no app_config_dir".to_string())?;
    crate::conversations::append_exchange(&dir, &conversation_id, exchange)
}

#[tauri::command]
pub async fn list_conversations(
    app: tauri::AppHandle,
) -> Result<Vec<crate::conversations::ConversationIndexEntry>, String> {
    let dir = config_dir_of(&app).ok_or_else(|| "no app_config_dir".to_string())?;
    crate::conversations::list(&dir)
}

#[tauri::command]
pub async fn load_conversation(
    app: tauri::AppHandle,
    conversation_id: String,
) -> Result<Vec<crate::conversations::StoredExchange>, String> {
    let dir = config_dir_of(&app).ok_or_else(|| "no app_config_dir".to_string())?;
    crate::conversations::read(&dir, &conversation_id)
}

#[tauri::command]
pub async fn search_conversations(
    app: tauri::AppHandle,
    query: String,
) -> Result<Vec<crate::conversations::SearchHit>, String> {
    let dir = config_dir_of(&app).ok_or_else(|| "no app_config_dir".to_string())?;
    // Cap at 50 hits to keep the renderer responsive — a longer match
    // list is almost certainly a too-broad query.
    crate::conversations::search(&dir, &query, 50)
}

#[tauri::command]
pub async fn delete_conversation(
    app: tauri::AppHandle,
    conversation_id: String,
) -> Result<(), String> {
    let dir = config_dir_of(&app).ok_or_else(|| "no app_config_dir".to_string())?;
    crate::conversations::delete(&dir, &conversation_id)
}

// ── Suggested-tone icons (v0.1.3) ──────────────────────────────────
//
// Pure, stateless function: takes the current Fingerprint and returns
// up to 3 ToneSuggestions selected from a fixed vocabulary based on
// dial averages and verdict distribution. R-layer; no LLM, no async.
//
// The frontend invokes this after each calibration / refresh and after
// loading a saved conversation; renders the result as clickable pills
// above the composer.

#[tauri::command]
pub async fn suggested_tones(
    fingerprint: crate::schema::Fingerprint,
    state: State<'_, AppState>,
) -> Result<Vec<crate::schema::ToneSuggestion>, String> {
    // v0.1.7: read target ratio + sensed split so the cue selection
    // can be gap-driven. Falls back to fingerprint-only behaviour when
    // either signal is unavailable (no active flavour, missing mapping).
    let target_held = Some(state.settings.read().await.target_split_held);
    let sensed = match state.flavour.read().await.as_ref() {
        Some(flv) => crate::rules::sensed_split::compute(&fingerprint, flv),
        None => None,
    };
    Ok(crate::rules::tone_suggestions::derive(
        &fingerprint,
        target_held,
        sensed.as_ref(),
    ))
}

// ── Sensed split (v0.1.7) ──────────────────────────────────────────
//
// Stateless command: caller passes the current fingerprint, the engine
// computes the sensed split under the active flavour's
// split_ratio_mapping. Returns None as a serialised null when the
// flavour has no mapping declared (legacy flavours) or the fingerprint
// is empty.
//
// Canon discipline: this is the instrument's reading (sensed-split
// register), never the practitioner's self-rated split ratio.

#[tauri::command]
pub async fn sensed_split(
    fingerprint: crate::schema::Fingerprint,
    state: State<'_, AppState>,
) -> Result<Option<crate::schema::SensedSplit>, String> {
    match state.flavour.read().await.as_ref() {
        Some(flv) => Ok(crate::rules::sensed_split::compute(&fingerprint, flv)),
        None => Ok(None),
    }
}

// ── Live per-turn sensed split (v0.1.7) ────────────────────────────
//
// Drives the needle on each chat round. Deliberately FAST: deterministic
// dials on the model's reply text, regex classification only — NO extra
// LLM/Ollama call, so it returns in microseconds and the needle responds
// immediately. SDC-clean: the AI never issues this reading; bounded signals
// (dials) are mapped to a held value by code. Calibration stays the baseline
// reading; this is the live layer.
#[tauri::command]
pub async fn sensed_split_turn(
    response_text: String,
    state: State<'_, AppState>,
) -> Result<Option<crate::schema::SensedSplit>, String> {
    let classification = crate::rules::classify_response::regex_fallback(&response_text);
    let dials =
        crate::rules::dials::compute_dials(&response_text, &classification.category, None);
    match state.flavour.read().await.as_ref() {
        Some(flv) => Ok(crate::rules::sensed_split::compute_for_response(&dials, flv)),
        None => Ok(None),
    }
}

#[allow(dead_code)]
fn _unused(_arc: Arc<()>) {}
