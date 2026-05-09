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

// Conversation history + search (v0.1.2+).
//
// Each exchange is recorded with the model and flavour active at the time
// of sending. Conversations are append-only on disk; the in-memory chat
// keeps its own copy and is the source of truth for the active session
// — these IPCs persist a copy and let prior sessions be replayed.
//
// All five commands fail soft: callers should wrap in try/catch and log
// without breaking the chat flow. The persistence layer is opportunistic;
// the chat remains usable if it fails.
export const Conversations = {
  // Append one exchange (role: 'user' | 'assistant') to a conversation.
  // The conversation is created on first call for a given id.
  saveExchange: (conversationId, exchange) =>
    invoke('save_exchange', { conversationId, exchange }),

  // List all stored conversations, sorted most-recent-first.
  // Each entry is { id, title, started_at_iso, last_at_iso,
  // exchange_count, flavour, last_model }.
  list: () => invoke('list_conversations'),

  // Read all exchanges in one conversation, in order. Returns array of
  // { role, content, timestamp_iso, model, flavour }.
  load: (conversationId) =>
    invoke('load_conversation', { conversationId }),

  // Case-insensitive substring search across titles and exchange contents.
  // Returns array of { conversation_id, conversation_title, exchange_index,
  // role, snippet }, capped at 50 hits.
  search: (query) => invoke('search_conversations', { query }),

  // Delete a conversation file and remove its index entry.
  delete: (conversationId) =>
    invoke('delete_conversation', { conversationId }),
};
