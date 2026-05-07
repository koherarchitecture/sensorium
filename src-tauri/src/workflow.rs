// Workflow capture — local-only, lightweight. Tracks foreground app
// process names, prompt categories the user types, and time-of-day
// histograms. Used to bias probe-framing selection (§11 spec).
//
// v0.1 stub — full capture lands when the app surface is wired up.

use crate::schema::WorkflowState;
use chrono::Utc;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::RwLock;

static STATE: OnceLock<RwLock<WorkflowState>> = OnceLock::new();

fn state() -> &'static RwLock<WorkflowState> {
    STATE.get_or_init(|| {
        RwLock::new(WorkflowState {
            last_updated: Utc::now().to_rfc3339(),
            prompt_categories: HashMap::new(),
            foreground_app_frequency: HashMap::new(),
            time_of_day_histogram: HashMap::new(),
        })
    })
}

pub fn current() -> WorkflowState {
    state().read().unwrap().clone()
}

pub fn clear() {
    let mut s = state().write().unwrap();
    s.prompt_categories.clear();
    s.foreground_app_frequency.clear();
    s.time_of_day_histogram.clear();
    s.last_updated = Utc::now().to_rfc3339();
}

/// Classify a user prompt into a category (code / writing / data / general)
/// using simple keyword heuristics. Used during chat to update the workflow.
pub fn classify_prompt(prompt: &str) -> &'static str {
    let lc = prompt.to_lowercase();
    let code_kw = [
        "function", "class ", "const ", "let ", "var ", "import ",
        "syntax", "compile", "debug", "regex", "rust", "python", "javascript",
        "typescript", "loop", "array", "iterate", "method", "call ", "callback",
    ];
    let writing_kw = [
        "essay", "draft", "letter", "paragraph", "tone", "rewrite",
        "edit", "punctuation", "phrasing", "outline", "story", "narrative",
    ];
    let data_kw = [
        "csv", "spreadsheet", "table", "column", "row", "regression",
        "statistic", "analysis", "dataset", "correlation", "histogram",
    ];

    if code_kw.iter().any(|k| lc.contains(k)) {
        "code"
    } else if writing_kw.iter().any(|k| lc.contains(k)) {
        "writing"
    } else if data_kw.iter().any(|k| lc.contains(k)) {
        "data"
    } else {
        "general"
    }
}
