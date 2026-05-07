// ipc.js — Tauri IPC wrapper with browser-mode fallback.
//
// In Tauri runtime the global window.__TAURI__ is injected (we enable
// `withGlobalTauri` in tauri.conf.json). When the renderer is opened
// directly in a browser for design preview, the global is absent; this
// wrapper returns null/false from has*-style probes and rejects with a
// recognisable error from action-style calls so callers can fall back
// to mock content. The intent is that `index.html` opened in Chrome
// still works as a static preview.

const _t = (typeof window !== 'undefined') ? window.__TAURI__ : undefined;
export const isTauri = Boolean(_t && _t.core && typeof _t.core.invoke === 'function');

export class NotInTauri extends Error {
  constructor(cmd) {
    super(`IPC ${cmd} unavailable: not running under Tauri`);
    this.name = 'NotInTauri';
    this.command = cmd;
  }
}

export async function invoke(cmd, args) {
  if (!isTauri) throw new NotInTauri(cmd);
  return _t.core.invoke(cmd, args);
}

export async function listen(eventName, handler) {
  if (!isTauri) {
    return () => {};
  }
  return _t.event.listen(eventName, handler);
}

// ── Convenience wrappers for the documented IPC surface ─────────────

export const SystemSetup = {
  systemInfo: () => invoke('system_info'),
  recommendOllamaModel: () => invoke('recommend_ollama_model'),
};

export const Settings = {
  get: () => invoke('get_settings'),
  update: (settings) => invoke('update_settings', { new: settings }),
};

export const ApiKey = {
  has: () => invoke('has_api_key'),
  set: (key) => invoke('set_api_key', { key }),
  clear: () => invoke('clear_api_key'),
};

export const Provider = {
  listModels: () => invoke('list_models'),
};

export const Ollama = {
  status: () => invoke('ollama_status'),
  // Pull a model from the Ollama registry. Resolves when the pull
  // completes (status: "success") or rejects with an error string.
  // Progress lines arrive on the ollama-pull-progress event with
  // payload { status, digest?, total?, completed?, error? }.
  pull: (model) => invoke('ollama_pull', { model }),
  onPullProgress: (handler) => listen('ollama-pull-progress', handler),
};

export const Calibration = {
  run: () => invoke('run_calibration'),
  fullRefresh: () => invoke('run_full_refresh'),
};

export const Chat = {
  // messages: array of { role, content } turns. The renderer keeps
  // history; Rust side accepts the full transcript per call (see
  // ipc.rs::send_chat_message). Streaming chunks arrive on the
  // chat-chunk event with payload { delta, done }.
  send: (model, messages) => invoke('send_chat_message', { model, messages }),
  onChunk: (handler) => listen('chat-chunk', handler),
};

export const Probes = {
  getSet: () => invoke('get_probe_set'),
};

export const Workflow = {
  get: () => invoke('get_workflow'),
  clear: () => invoke('clear_workflow'),
};
