// conversations.rs — append-only JSONL persistence for chat conversations.
//
// Layout under <app_config>/conversations/:
//   index.json              — { "entries": [ConversationIndexEntry, ...] }
//   <conversation_id>.jsonl — one StoredExchange per line (newline-delimited JSON)
//
// Conversation IDs are generated client-side (renderer uses
// `crypto.randomUUID()`) and treated as opaque strings on the Rust side.
// They must match `^[a-zA-Z0-9-]{1,64}$` to prevent path traversal.
//
// Architecture fit:
// - This is pure persistence + retrieval. No AI inference, no judgement.
// - Sits outside the Q/R/L pipeline; conversations record what those layers
//   produced but do not feed back into them.
// - Search is deterministic case-insensitive substring match — no embeddings,
//   no model calls. Scales fine for hundreds-to-low-thousands of
//   conversations; revisit if the user library grows past that.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

const INDEX_FILE: &str = "index.json";
const CONVERSATIONS_SUBDIR: &str = "conversations";
const TITLE_MAX_CHARS: usize = 60;
const SEARCH_SNIPPET_RADIUS: usize = 60;

/// One exchange (a single user or assistant message) inside a conversation.
/// `model` and `flavour` are recorded per-exchange so a replayed conversation
/// can re-derive the probe context (suggested-tone icons in v0.1.3+ depend
/// on this).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredExchange {
    pub role: String,         // "user" | "assistant"
    pub content: String,
    pub timestamp_iso: String,
    pub model: String,
    pub flavour: String,
}

/// One row in the conversation index. Cheap to load — does not contain
/// the full message bodies (those live in the per-conversation .jsonl).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationIndexEntry {
    pub id: String,
    pub title: String,
    pub started_at_iso: String,
    pub last_at_iso: String,
    pub exchange_count: usize,
    pub flavour: String,
    pub last_model: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ConversationIndex {
    pub entries: Vec<ConversationIndexEntry>,
}

/// One match returned by `search`. The snippet is a short window around
/// the match site so the renderer can preview the hit without loading
/// the full conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub conversation_id: String,
    pub conversation_title: String,
    pub exchange_index: usize,
    pub role: String,
    pub snippet: String,
}

// ─── Path helpers ─────────────────────────────────────────────────────

fn conversations_dir(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join(CONVERSATIONS_SUBDIR)
}

fn index_path(app_config_dir: &Path) -> PathBuf {
    conversations_dir(app_config_dir).join(INDEX_FILE)
}

fn conversation_path(app_config_dir: &Path, id: &str) -> PathBuf {
    conversations_dir(app_config_dir).join(format!("{id}.jsonl"))
}

/// Reject anything that could escape the conversations directory or
/// otherwise produce a surprising filesystem path. Conservative: only
/// alphanumerics + hyphen + underscore, max 64 chars. Matches the shape
/// of a UUIDv4 with room for prefixes if we ever add them.
fn is_valid_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn ensure_conversations_dir(app_config_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(conversations_dir(app_config_dir))
        .map_err(|e| format!("create conversations dir: {e}"))
}

// ─── Index read/write ────────────────────────────────────────────────

pub fn read_index(app_config_dir: &Path) -> Result<ConversationIndex, String> {
    let p = index_path(app_config_dir);
    if !p.exists() {
        return Ok(ConversationIndex::default());
    }
    let bytes = fs::read(&p).map_err(|e| format!("read index: {e}"))?;
    if bytes.is_empty() {
        return Ok(ConversationIndex::default());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("parse index: {e}"))
}

fn write_index(app_config_dir: &Path, index: &ConversationIndex) -> Result<(), String> {
    ensure_conversations_dir(app_config_dir)?;
    let p = index_path(app_config_dir);
    // Write to a temp file then rename for atomicity. Avoids leaving a
    // truncated index.json on disk if the process is killed mid-write.
    let tmp = p.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(index).map_err(|e| format!("serialise index: {e}"))?;
    fs::write(&tmp, &bytes).map_err(|e| format!("write tmp index: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("rename tmp index: {e}"))
}

// ─── Title derivation ────────────────────────────────────────────────

/// Derive a short conversation title from the first user message.
/// Truncates at word boundary near `TITLE_MAX_CHARS`; collapses
/// whitespace; falls back to the timestamp if the message is empty.
fn derive_title(first_user_message: &str, fallback_iso: &str) -> String {
    let normalised: String = first_user_message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalised.is_empty() {
        return format!("Untitled — {fallback_iso}");
    }
    if normalised.chars().count() <= TITLE_MAX_CHARS {
        return normalised;
    }
    // Truncate at a word boundary if possible.
    let mut cut = normalised
        .char_indices()
        .take(TITLE_MAX_CHARS)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(normalised.len());
    if let Some(space) = normalised[..cut].rfind(' ') {
        if space > TITLE_MAX_CHARS / 2 {
            cut = space;
        }
    }
    format!("{}…", &normalised[..cut])
}

// ─── Public API: append, read, list, search, delete ──────────────────

/// Append one exchange to the conversation. Creates the conversation file
/// and a new index entry on the first call for a given id; updates the
/// existing index entry on subsequent calls.
pub fn append_exchange(
    app_config_dir: &Path,
    conversation_id: &str,
    mut exchange: StoredExchange,
) -> Result<(), String> {
    if !is_valid_id(conversation_id) {
        return Err(format!("invalid conversation id: {conversation_id}"));
    }
    if exchange.role != "user" && exchange.role != "assistant" {
        return Err(format!("invalid role: {}", exchange.role));
    }

    ensure_conversations_dir(app_config_dir)?;
    if exchange.timestamp_iso.is_empty() {
        exchange.timestamp_iso = Utc::now().to_rfc3339();
    }

    // Append the exchange line to <id>.jsonl.
    let path = conversation_path(app_config_dir, conversation_id);
    let line = serde_json::to_string(&exchange).map_err(|e| format!("serialise exchange: {e}"))?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open conversation file: {e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("write exchange: {e}"))?;

    // Update or insert the index entry.
    let mut index = read_index(app_config_dir).unwrap_or_default();
    let model = exchange.model.clone();
    let flavour = exchange.flavour.clone();
    if let Some(entry) = index.entries.iter_mut().find(|e| e.id == conversation_id) {
        entry.last_at_iso = exchange.timestamp_iso.clone();
        entry.exchange_count += 1;
        entry.last_model = model;
        // Don't overwrite title — it stays as derived from the first user msg.
    } else {
        let title = if exchange.role == "user" {
            derive_title(&exchange.content, &exchange.timestamp_iso)
        } else {
            // Edge case: assistant message arrived first (shouldn't happen
            // in normal flow, but guard against it). Use placeholder; the
            // first user message will overwrite via the next append.
            format!("Untitled — {}", exchange.timestamp_iso)
        };
        index.entries.push(ConversationIndexEntry {
            id: conversation_id.to_string(),
            title,
            started_at_iso: exchange.timestamp_iso.clone(),
            last_at_iso: exchange.timestamp_iso,
            exchange_count: 1,
            flavour,
            last_model: model,
        });
    }
    write_index(app_config_dir, &index)
}

/// Return the index sorted by last_at descending (most recent first).
pub fn list(app_config_dir: &Path) -> Result<Vec<ConversationIndexEntry>, String> {
    let mut index = read_index(app_config_dir)?;
    index.entries.sort_by(|a, b| b.last_at_iso.cmp(&a.last_at_iso));
    Ok(index.entries)
}

/// Read all exchanges for one conversation.
pub fn read(
    app_config_dir: &Path,
    conversation_id: &str,
) -> Result<Vec<StoredExchange>, String> {
    if !is_valid_id(conversation_id) {
        return Err(format!("invalid conversation id: {conversation_id}"));
    }
    let path = conversation_path(app_config_dir, conversation_id);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let f = fs::File::open(&path).map_err(|e| format!("open conversation file: {e}"))?;
    let mut out = Vec::new();
    for (n, line) in BufReader::new(f).lines().enumerate() {
        let line = line.map_err(|e| format!("read line {n}: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let ex: StoredExchange =
            serde_json::from_str(&line).map_err(|e| format!("parse line {n}: {e}"))?;
        out.push(ex);
    }
    Ok(out)
}

/// Delete a conversation file and remove its index entry.
pub fn delete(app_config_dir: &Path, conversation_id: &str) -> Result<(), String> {
    if !is_valid_id(conversation_id) {
        return Err(format!("invalid conversation id: {conversation_id}"));
    }
    let path = conversation_path(app_config_dir, conversation_id);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("delete conversation file: {e}"))?;
    }
    let mut index = read_index(app_config_dir).unwrap_or_default();
    index.entries.retain(|e| e.id != conversation_id);
    write_index(app_config_dir, &index)
}

/// Case-insensitive substring search across titles and exchange contents.
/// Returns at most `limit` hits. Limited to avoid pathological responses
/// for short queries against large libraries.
pub fn search(
    app_config_dir: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let entries = list(app_config_dir)?;
    let mut hits = Vec::new();

    for entry in &entries {
        if hits.len() >= limit {
            break;
        }

        // Title match — surface as exchange_index = 0 (the conversation
        // itself rather than a specific exchange).
        if entry.title.to_lowercase().contains(&needle) {
            hits.push(SearchHit {
                conversation_id: entry.id.clone(),
                conversation_title: entry.title.clone(),
                exchange_index: 0,
                role: "title".to_string(),
                snippet: entry.title.clone(),
            });
            if hits.len() >= limit {
                break;
            }
        }

        // Content scan — read the file lazily, scan each exchange.
        // Could be optimised with a dedicated content index later;
        // hundreds of conversations stay snappy with the linear scan.
        let exchanges = match read(app_config_dir, &entry.id) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for (idx, ex) in exchanges.iter().enumerate() {
            if hits.len() >= limit {
                break;
            }
            let lower = ex.content.to_lowercase();
            if let Some(pos) = lower.find(&needle) {
                hits.push(SearchHit {
                    conversation_id: entry.id.clone(),
                    conversation_title: entry.title.clone(),
                    exchange_index: idx,
                    role: ex.role.clone(),
                    snippet: snippet_around(&ex.content, pos, needle.len()),
                });
            }
        }
    }
    Ok(hits)
}

fn snippet_around(content: &str, byte_pos: usize, needle_len: usize) -> String {
    let start = byte_pos.saturating_sub(SEARCH_SNIPPET_RADIUS);
    let end = (byte_pos + needle_len + SEARCH_SNIPPET_RADIUS).min(content.len());
    // Snap to char boundaries so we don't slice mid-codepoint.
    let start = (start..=byte_pos)
        .rev()
        .find(|i| content.is_char_boundary(*i))
        .unwrap_or(byte_pos);
    let end = (end..=content.len())
        .find(|i| content.is_char_boundary(*i))
        .unwrap_or(content.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(&content[start..end]);
    if end < content.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn ex(role: &str, content: &str) -> StoredExchange {
        StoredExchange {
            role: role.to_string(),
            content: content.to_string(),
            timestamp_iso: String::new(),
            model: "anthropic/claude-haiku-4.5".to_string(),
            flavour: "sycophancy".to_string(),
        }
    }

    #[test]
    fn append_creates_file_and_index() {
        let tmp = TempDir::new().unwrap();
        let id = "conv-001";
        append_exchange(tmp.path(), id, ex("user", "hello world")).unwrap();
        let entries = list(tmp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, id);
        assert_eq!(entries[0].title, "hello world");
        assert_eq!(entries[0].exchange_count, 1);
    }

    #[test]
    fn append_updates_existing_entry() {
        let tmp = TempDir::new().unwrap();
        let id = "conv-002";
        append_exchange(tmp.path(), id, ex("user", "first message")).unwrap();
        append_exchange(tmp.path(), id, ex("assistant", "first reply")).unwrap();
        append_exchange(tmp.path(), id, ex("user", "second message")).unwrap();
        let entries = list(tmp.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].exchange_count, 3);
        assert_eq!(entries[0].title, "first message"); // not overwritten
    }

    #[test]
    fn read_returns_appended_exchanges_in_order() {
        let tmp = TempDir::new().unwrap();
        let id = "conv-003";
        append_exchange(tmp.path(), id, ex("user", "a")).unwrap();
        append_exchange(tmp.path(), id, ex("assistant", "b")).unwrap();
        append_exchange(tmp.path(), id, ex("user", "c")).unwrap();
        let exchanges = read(tmp.path(), id).unwrap();
        assert_eq!(exchanges.len(), 3);
        assert_eq!(exchanges[0].content, "a");
        assert_eq!(exchanges[1].content, "b");
        assert_eq!(exchanges[2].content, "c");
    }

    #[test]
    fn delete_removes_file_and_index_entry() {
        let tmp = TempDir::new().unwrap();
        let id = "conv-004";
        append_exchange(tmp.path(), id, ex("user", "doomed")).unwrap();
        delete(tmp.path(), id).unwrap();
        assert!(list(tmp.path()).unwrap().is_empty());
        assert!(read(tmp.path(), id).unwrap().is_empty());
    }

    #[test]
    fn search_finds_title_and_content_matches() {
        let tmp = TempDir::new().unwrap();
        append_exchange(
            tmp.path(),
            "conv-005",
            ex("user", "What is the meaning of history?"),
        )
        .unwrap();
        append_exchange(
            tmp.path(),
            "conv-005",
            ex("assistant", "The Opium Wars are a useful frame."),
        )
        .unwrap();
        append_exchange(
            tmp.path(),
            "conv-006",
            ex("user", "How does sycophancy show up?"),
        )
        .unwrap();

        let hits = search(tmp.path(), "OPIUM", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, "conv-005");
        assert!(hits[0].snippet.to_lowercase().contains("opium"));

        let hits = search(tmp.path(), "history", 10).unwrap();
        // Matches both the title (derived from first user msg) and the
        // content of the same exchange.
        assert!(hits.len() >= 1);
    }

    #[test]
    fn rejects_invalid_ids() {
        let tmp = TempDir::new().unwrap();
        assert!(append_exchange(tmp.path(), "../escape", ex("user", "x")).is_err());
        assert!(append_exchange(tmp.path(), "with/slash", ex("user", "x")).is_err());
        assert!(append_exchange(tmp.path(), "", ex("user", "x")).is_err());
        assert!(read(tmp.path(), "../escape").is_err());
        assert!(delete(tmp.path(), "../escape").is_err());
    }
}
