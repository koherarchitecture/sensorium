// Sensorium — application entry
//
// Wires the Tauri app, registers IPC commands, sets up the runtime
// state container. Each module owns one architectural concern:
//   - keychain: API-key storage via OS-native credential store
//   - settings: preferences.json read/write
//   - schema: serde data shapes (baselines, sessions, fingerprints)
//   - ollama: local Ollama HTTP client + model recommendations
//   - providers: OpenRouter HTTP client (chat + narration)
//   - probes: probe runner + refusal-shape strategy
//   - rules: Stage 2 deterministic classification + aggregation
//   - narrator: Haiku-via-OpenRouter narration generator
//   - workflow: lightweight workflow capture (local-only)

mod schema;
mod keychain;
mod settings;
mod system_info;
mod ollama;
mod providers;
mod probes;
mod rules;
mod narrator;
mod workflow;
mod flavour;
mod ipc;

use std::sync::Arc;
use tauri::Manager;
use tokio::sync::RwLock;

/// Shared application state passed to every IPC handler.
pub struct AppState {
    pub settings: Arc<RwLock<settings::Settings>>,
    pub openrouter_key: Arc<RwLock<Option<String>>>,
    /// Active flavour configuration loaded on startup. None if no flavour
    /// could be loaded — callers should treat this as an error condition.
    pub flavour: Arc<RwLock<Option<schema::FlavourConfig>>>,
    /// Per-model pricing cache: model_id → (USD per prompt token, USD per
    /// completion token). Populated by `list_models` IPC; consulted by
    /// `send_chat_message` to compute streamed-chat cost (the SSE stream
    /// from OpenRouter does not include cost; the runner's non-streaming
    /// `complete()` calls get cost directly from `usage.cost`).
    pub pricing_cache: Arc<RwLock<std::collections::HashMap<String, (f64, f64)>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "sensorium_lib=info".into()),
        )
        .init();

    // Attempt to load the default flavour at startup. The actual paths
    // (user-data, bundle-resource) are resolved inside the loader; the
    // dev fallback (./flavours/<slug>.json) covers `cargo tauri dev`.
    let initial_flavour = match flavour::load_flavour(
        flavour::DEFAULT_FLAVOUR_SLUG,
        None,
        None,
    ) {
        Ok(cfg) => {
            tracing::info!("loaded flavour '{}' v{}", cfg.slug, cfg.flavour_version);
            Some(cfg)
        }
        Err(e) => {
            tracing::error!("failed to load default flavour: {}", e);
            None
        }
    };

    // Note: env-var key seeding (SENSORIUM_DEV_KEY) is moved into the
    // setup callback below so we have access to the resolved app config
    // dir for the encrypted-file fallback path.

    let state = AppState {
        settings: Arc::new(RwLock::new(settings::Settings::default())),
        openrouter_key: Arc::new(RwLock::new(None)),
        flavour: Arc::new(RwLock::new(initial_flavour)),
        pricing_cache: Arc::new(RwLock::new(std::collections::HashMap::new())),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            // System / setup
            ipc::system_info,
            ipc::recommend_ollama_model,

            // Settings
            ipc::get_settings,
            ipc::update_settings,

            // API key
            ipc::has_api_key,
            ipc::set_api_key,
            ipc::clear_api_key,

            // Provider
            ipc::list_models,

            // Ollama
            ipc::ollama_status,
            ipc::ollama_pull,

            // Calibration / refresh
            ipc::run_calibration,
            ipc::run_full_refresh,

            // Chat
            ipc::send_chat_message,

            // Probe set transparency
            ipc::get_probe_set,

            // Flavour management
            ipc::seed_active_flavour,

            // Workflow
            ipc::get_workflow,
            ipc::clear_workflow,
        ])
        .setup(|app| {
            tracing::info!("Sensorium starting up");
            // Resolve the app config dir up front — used by both settings
            // persistence and the keychain fallback (encrypted-file path).
            let handle = app.handle().clone();
            let app_config_dir = handle.path().app_config_dir().ok();
            let state: tauri::State<AppState> = handle.state();
            *state.settings.blocking_write() = settings::load_from_disk(&handle);

            // Optional dev/CI seeding via SENSORIUM_DEV_KEY. Only writes
            // when no key is already stored. Tries the OS keychain first;
            // falls back to the encrypted file if the keychain is
            // unavailable. Production launches leave the var unset.
            if let Ok(env_key) = std::env::var("SENSORIUM_DEV_KEY") {
                let already = matches!(
                    keychain::get_openrouter_key(app_config_dir.as_deref()),
                    Ok(Some(_))
                );
                if !already {
                    if let Err(e) = keychain::set_openrouter_key(&env_key, app_config_dir.as_deref()) {
                        tracing::warn!("SENSORIUM_DEV_KEY seed failed: {e}");
                    } else {
                        tracing::info!("seeded OpenRouter key from SENSORIUM_DEV_KEY");
                    }
                }
            }

            // Load API key into AppState if present (keychain or fallback).
            if let Ok(Some(k)) = keychain::get_openrouter_key(app_config_dir.as_deref()) {
                *state.openrouter_key.blocking_write() = Some(k);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running koher sensorium");
}
