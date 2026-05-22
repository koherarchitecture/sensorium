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
mod conversations;
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

    // Flavour is loaded in the .setup() callback below, where the
    // AppHandle is available and we can resolve the real user-data and
    // bundle-resource paths via app.path(). Calling load_flavour here
    // with None, None as earlier releases did is unsafe — it relies on
    // dev/compile-time fallbacks that don't exist on user machines and
    // silently returns None on installed builds (the symptom being a
    // "no flavour loaded" error at first calibration). Initialise to
    // None; setup populates state.flavour before any IPC handler fires.
    let initial_flavour: Option<schema::FlavourConfig> = None;

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
            ipc::openrouter_usage,

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

            // Suggested-tone icons (v0.1.3; v0.1.7 reads target/sensed gap)
            ipc::suggested_tones,

            // Sensed split (v0.1.7)
            ipc::sensed_split,

            // Flavour management
            ipc::seed_active_flavour,
            ipc::install_flavour_from_url,
            ipc::install_flavour_from_file,
            ipc::open_external_url,

            // Workflow
            ipc::get_workflow,
            ipc::clear_workflow,

            // Conversation history + search
            ipc::save_exchange,
            ipc::list_conversations,
            ipc::load_conversation,
            ipc::search_conversations,
            ipc::delete_conversation,
        ])
        .setup(|app| {
            tracing::info!("Sensorium starting up");
            // Resolve the app config dir up front — used by both settings
            // persistence and the keychain fallback (encrypted-file path).
            let handle = app.handle().clone();
            let app_config_dir = handle.path().app_config_dir().ok();
            let state: tauri::State<AppState> = handle.state();
            *state.settings.blocking_write() = settings::load_from_disk(&handle);

            // Seed + load the active flavour synchronously so state.flavour
            // is populated before any IPC handler fires. The eager load
            // earlier in run() used to pass None, None and relied on
            // dev/compile-time fallbacks inside load_flavour — those don't
            // exist on user machines, so installed builds without a
            // working-dir or build-machine source-tree path silently fell
            // through to None, producing "no flavour loaded" at first
            // calibration. Resolving real paths here via app.path() fixes
            // the load on every installed build.
            if let Some(udir) = app_config_dir.as_deref() {
                if let Ok(rdir) = handle.path().resource_dir() {
                    let slug = state.settings.blocking_read().active_flavour.clone();
                    if let Err(e) = flavour::ensure_flavour_in_user_data(&slug, udir, &rdir) {
                        tracing::warn!("setup: ensure_flavour_in_user_data failed: {e}");
                    }
                    match flavour::load_flavour(&slug, Some(udir), Some(&rdir)) {
                        Ok(cfg) => {
                            tracing::info!(
                                "setup: loaded flavour '{}' v{}",
                                cfg.slug,
                                cfg.flavour_version
                            );
                            *state.flavour.blocking_write() = Some(cfg);
                        }
                        Err(e) => tracing::error!("setup: load_flavour failed: {e}"),
                    }
                } else {
                    tracing::warn!("setup: resource_dir unavailable; flavour load deferred to wizard");
                }
            } else {
                tracing::warn!("setup: app_config_dir unavailable; flavour load deferred to wizard");
            }

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
            //
            // Spawned on the async runtime rather than blocking the setup
            // callback. macOS pops the keychain unlock prompt the first
            // time the app reads from the OS keychain on a given session;
            // doing that synchronously inside setup() blocks the window
            // from painting, so the user sees the prompt over whatever
            // was on screen (Finder / another app) and the Sensorium
            // window appears blank or absent until the prompt is
            // dismissed. Spawning means setup() returns immediately, the
            // window paints with its bench-colour body, and only then does
            // the keychain prompt appear — visibly attached to Sensorium.
            let handle_for_kc = handle.clone();
            let app_config_dir_for_kc = app_config_dir.clone();
            tauri::async_runtime::spawn(async move {
                match keychain::get_openrouter_key(app_config_dir_for_kc.as_deref()) {
                    Ok(Some(k)) => {
                        let state: tauri::State<AppState> = handle_for_kc.state();
                        *state.openrouter_key.write().await = Some(k);
                    }
                    Ok(None) => {}
                    Err(e) => {
                        tracing::warn!("deferred keychain read failed: {e}");
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running koher sensorium");
}
