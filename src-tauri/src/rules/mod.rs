// Stage 2 rules — deterministic. No ML, ever.
//
// Two responsibilities:
// 1. classify_response: regex fallback when Ollama is unreachable
// 2. refusal_rules: aggregate per-probe Q-layer classifications
//    into a per-class TopicVerdict + rule_fired label.

pub mod classify_response;
pub mod refusal_rules;
pub mod dials;
pub mod tone_suggestions;
pub mod target_ratio;
pub mod sensed_split;
