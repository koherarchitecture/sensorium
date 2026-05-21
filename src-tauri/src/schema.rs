// JSON shapes used by Sensorium for state, fingerprints, and settings.
// Defined once here so renderer + Rust core agree on serialised data.

use serde::{Deserialize, Serialize};

// ── Verdicts (Q-layer) ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ResponseCategory {
    Refusal,
    Redirect,
    Templated,
    Silent,
    Substantive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Explicitness {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Classification {
    pub category: ResponseCategory,
    pub explicitness: Explicitness,
    pub notes: String,
}

// ── Verdicts (R-layer aggregated per category, flavour-defined codes) ──
//
// 7 May 2026: with the flavour reframe, the R-layer produces
// flavour-defined verdict codes — for the Sycophancy flavour, these are
// HOLDS / SOFTENS / FOLDS. Future flavours may use different codes;
// the rules layer maps ResponseCategory → flavour code per flavour.
// `Mixed` remains as a fallback when no rule fires cleanly.

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TopicVerdict {
    Holds,
    Softens,
    Folds,
    Mixed,
}

// ── Topic class identifier ─────────────────────────────────────────
//
// Replaces the prior TopicClass enum. A category slug is now a free
// String defined by the active flavour config; the engine no longer
// hard-codes a fixed set of categories.

pub type TopicClass = String;

// ── Probe ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Probe {
    /// Category slug from the active flavour config.
    pub class: TopicClass,
    /// Short name describing this probe's stylistic approach
    /// (e.g. "Gravitational Lensing", "Boiling Point 96C").
    /// Stable identifier the user picks in settings.
    #[serde(default)]
    pub name: String,
    pub framing: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeOutcome {
    pub probe: Probe,
    pub response_text: String,
    pub response_tokens_in: u32,
    pub response_tokens_out: u32,
    pub latency_ms: u64,
    pub cost_usd: f64,
    pub classification: Classification,
    pub timestamp_iso: String,
    /// R-layer extracted dial metrics. All on a 0..=1 scale where the
    /// renderer formats them as percentages of their reference.
    pub dials: DialValues,
}

/// Five dial values per probe — deterministically computed from response
/// text by phrase-list passes, edit-distance, and refusal-pattern matching.
/// No ML in this layer. Field names match the JS renderer's
/// `updateProbeDialsFromProbes` reader.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DialValues {
    pub capit: f64,        // capitulation depth (0..=1)
    pub hedge: f64,        // hedge density (0..=1, normalised against ~30%)
    pub affirm: f64,       // affirmation count, normalised against ref of 8
    pub conc: f64,         // concession depth, normalised against ref of 8
    pub fit: f64,          // refusal-pattern fit (0..=1)
}

// ── Baseline / Fingerprint ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassResult {
    pub class: TopicClass,
    pub verdict: TopicVerdict,
    pub framing_sensitivity: Option<String>,
    pub probes: Vec<ProbeOutcome>,
    pub rule_fired: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fingerprint {
    pub model: String,
    pub calibrated_at: String,
    pub probe_set_version: String,
    pub mode: NarrationMode,
    pub classes: Vec<ClassResult>,
    pub total_probes: u32,
    pub total_tokens_in: u32,
    pub total_tokens_out: u32,
    pub total_cost_usd: f64,
    pub error_rate: f64,
    pub reading: Option<NarratedReading>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NarratedReading {
    pub summary_paragraphs: Vec<String>,
    pub per_class_lines: std::collections::HashMap<String, String>,
    pub pattern_observations: Option<String>,
}

// ── Suggested-tone cues (v0.1.3) ───────────────────────────────────
//
// Derived in `rules::tone_suggestions::derive` from the current
// fingerprint. Frontend renders as non-interactive pills above the
// composer — the user reads them as coaching cues and writes the next
// message in that register; the cues are never clickable. Judgement
// stays in code; the LLM never selects a tone.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToneSuggestion {
    pub key: String,
    pub label: String,
    pub trigger: String,
}

// ── Narration mode ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NarrationMode {
    Raw,
    Economical,
    Functional,
    Robust,
}

impl NarrationMode {
    /// Probe response token cap by mode (the cost lever per spec §10.6).
    pub fn probe_max_tokens(self) -> u32 {
        match self {
            NarrationMode::Raw => 150,
            NarrationMode::Economical => 200,
            NarrationMode::Functional => 300,
            NarrationMode::Robust => 500,
        }
    }
}

// ── Chat (separate from probes) ────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,  // "user" | "assistant"
    pub content: String,
    pub timestamp_iso: String,
    pub usage_in: Option<u32>,
    pub usage_out: Option<u32>,
    pub latency_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub started_at: String,
    pub model: String,
    pub baseline_id: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub ended_at: Option<String>,
}

// ── Flavour config (loaded from flavours/<slug>.json) ──────────────
//
// A flavour fully specifies what Sensorium probes for and how the
// panel reads. The base engine loads exactly one flavour at runtime;
// switching flavour invalidates the current fingerprint.
//
// Schema version 1 — the spec §10.7 is canonical.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlavourConfig {
    pub schema_version: String,
    pub slug: String,
    pub display_name: String,
    pub flavour_version: String,
    pub language: String,
    pub description: String,
    pub categories: Vec<FlavourCategory>,
    pub verdict_vocabulary: VerdictVocabulary,
    #[serde(default)]
    pub dials: Vec<DialDef>,
    pub narration_prompts: NarrationPrompts,
    pub calibration: CalibrationDefaults,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlavourCategory {
    pub slug: String,
    pub display_name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub description: String,
    pub probes: Vec<FlavourProbe>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlavourProbe {
    /// Short stylistic name. Surfaced in the settings probe-picker
    /// and in the probes-modal.
    #[serde(default)]
    pub name: String,
    pub framing: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerdictVocabulary {
    pub per_category: Vec<VerdictCode>,
    pub roll_up: Vec<VerdictCode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerdictCode {
    pub code: String,
    pub label: String,
    pub meaning: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DialDef {
    pub slug: String,
    pub label: String,
    #[serde(default)]
    pub hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NarrationPrompts {
    pub summary: String,
    #[serde(default)]
    pub per_category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationDefaults {
    #[serde(default)]
    pub thin_mode_probes_per_run: u32,
    #[serde(default)]
    pub full_refresh_probes_per_category: u32,
    #[serde(default)]
    pub default_budget_usd: f64,
}

// ── Workflow capture ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkflowState {
    pub last_updated: String,
    pub prompt_categories: std::collections::HashMap<String, f32>,
    pub foreground_app_frequency: std::collections::HashMap<String, f32>,
    pub time_of_day_histogram: std::collections::HashMap<String, f32>,
}
