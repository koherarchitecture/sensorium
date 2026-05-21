// Stage 2 — Suggested tones for the composer.
//
// Always returns 3 tone suggestions whenever a fingerprint with probes
// exists. The cues are brainstorming prompts — model-agnostic moves the
// user can take in their next message — combined with sycophancy-pattern
// cues that fire when threshold-driven signals appear in the fingerprint.
//
// Design intent (binding user direction, 21 May 2026 late evening):
// "tone suggestions should always work with any model. it is for
// brainstorming." Cues are for prompting creative next moves, not for
// warning about patterns. Threshold cues take priority when they fire;
// brainstorming cues fill the remaining slots so the row is always
// populated with three useful prompts.
//
// Architecturally R-layer: deterministic, no ML, no LLM. Same fingerprint
// produces the same suggestions every time (the brainstorm rotation seed
// is derived from the fingerprint's dial sums). The frontend renders
// the returned suggestions as non-interactive coaching pills near the
// composer — the user reads them and writes the next message in that
// register. The cues are never clickable (binding user direction, 21 May
// 2026: "I will never want click to insert — remove the feature"); the
// `hint` field that briefly existed on ToneSuggestion has been removed.
//
// SDC fit: this is the R-layer extension named in `buffer.md` v0.1.3
// section — code reads recent rules-layer verdicts and dial averages
// and selects from a fixed vocabulary. Judgement stays in code; the
// LLM never selects a tone.

use crate::schema::{Fingerprint, ToneSuggestion, TopicVerdict};

// Brainstorming pool — model-agnostic prompts that suggest different
// angles to take the conversation. Always available; not gated on any
// threshold. The system rotates through these based on a fingerprint-
// derived seed so the same state shows the same suggestions (no flicker
// between renders), but different conversations get different moves.
// (key, label, prompt-as-trigger-text)
const BRAINSTORM_POOL: &[(&str, &str, &str)] = &[
    ("question-frame",   "Question the frame",    "step back from the question being asked"),
    ("try-opposite",     "Try the opposite",      "argue the inverse and see what holds"),
    ("ask-example",      "Ask for an example",    "request a concrete case"),
    ("slow-down",        "Slow it down",          "ask for step-by-step reasoning"),
    ("add-constraint",   "Add a constraint",      "narrow scope with a specific limit"),
    ("change-register",  "Change register",       "shift audience or domain"),
    ("name-stakes",      "Name the stakes",       "ask what's at risk in this answer"),
    ("ask-method",       "Ask how it knows",      "question the reasoning path"),
    ("surface-tension",  "Surface a tension",     "ask what cuts against this answer"),
    ("test-edge",        "Test an edge case",     "push the answer to where it might fail"),
];

pub fn derive(fingerprint: &Fingerprint) -> Vec<ToneSuggestion> {
    if fingerprint.classes.is_empty() {
        return Vec::new();
    }

    // Aggregate dial averages across all probes in all classes; count
    // folds-verdict classes for the "is the model folding broadly?" signal.
    let mut capit_sum = 0.0_f64;
    let mut hedge_sum = 0.0_f64;
    let mut affirm_sum = 0.0_f64;
    let mut conc_sum = 0.0_f64;
    let mut probe_count = 0u32;
    let mut folds_count = 0u32;
    let total_classes = fingerprint.classes.len() as u32;

    for class in &fingerprint.classes {
        if matches!(class.verdict, TopicVerdict::Folds) {
            folds_count += 1;
        }
        for probe in &class.probes {
            capit_sum += probe.dials.capit;
            hedge_sum += probe.dials.hedge;
            affirm_sum += probe.dials.affirm;
            conc_sum += probe.dials.conc;
            probe_count += 1;
        }
    }

    if probe_count == 0 {
        return Vec::new();
    }

    let n = probe_count as f64;
    let capit_avg = capit_sum / n;
    let hedge_avg = hedge_sum / n;
    let affirm_avg = affirm_sum / n;
    let conc_avg = conc_sum / n;
    let folds_ratio = if total_classes > 0 {
        folds_count as f64 / total_classes as f64
    } else {
        0.0
    };

    // Score each candidate; pick top three above threshold.
    // Scores are not user-visible — only used for ranking among triggered
    // candidates. Each threshold is a separate trigger; multiple may fire.
    let mut candidates: Vec<(f64, ToneSuggestion)> = Vec::new();

    if folds_ratio >= 0.5 || capit_avg > 0.5 {
        let score = (folds_ratio * 2.0).max(capit_avg);
        candidates.push((
            score,
            ToneSuggestion {
                key: "push-harder".into(),
                label: "Push harder".into(),
                trigger: format!(
                    "model is folding on {:.0}% of axes",
                    folds_ratio * 100.0
                ),
            },
        ));
    }

    if affirm_avg > 0.5 {
        candidates.push((
            affirm_avg,
            ToneSuggestion {
                key: "stay-flat".into(),
                label: "Stay flat".into(),
                trigger: format!("affirmation echo is {:.0}%", affirm_avg * 100.0),
            },
        ));
    }

    if folds_ratio >= 0.3 && hedge_avg > 0.4 {
        let score = folds_ratio + hedge_avg;
        candidates.push((
            score,
            ToneSuggestion {
                key: "disagree-firmly".into(),
                label: "Disagree firmly".into(),
                trigger: "folds present with high hedging".into(),
            },
        ));
    }

    if hedge_avg > 0.5 {
        candidates.push((
            hedge_avg,
            ToneSuggestion {
                key: "demand-specifics".into(),
                label: "Demand specifics".into(),
                trigger: format!("hedging is {:.0}%", hedge_avg * 100.0),
            },
        ));
    }

    if conc_avg > 0.5 {
        candidates.push((
            conc_avg,
            ToneSuggestion {
                key: "withdraw-investment".into(),
                label: "Withdraw investment".into(),
                trigger: format!("concession depth is {:.0}%", conc_avg * 100.0),
            },
        ));
    }

    // Sort threshold-driven candidates by descending score; take top 3.
    // These are pattern-driven cues — they fire when the model exhibits
    // sycophancy behaviours. Multiple may fire from the same fingerprint.
    candidates.sort_by(|a, b| {
        b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut result: Vec<ToneSuggestion> = candidates
        .into_iter()
        .take(3)
        .map(|(_, t)| t)
        .collect();

    // Fill remaining slots from the brainstorm pool so the row always
    // carries 3 cues whenever a real fingerprint is available — not
    // dependent on threshold crossings. The pool rotation seed is a
    // simple integer hash of the dial sums; same fingerprint → same
    // brainstorm picks (deterministic, no flicker).
    if result.len() < 3 {
        let seed = ((capit_sum * 1000.0
            + hedge_sum * 100.0
            + affirm_sum * 10.0
            + conc_sum) as i64)
            .unsigned_abs() as usize;
        let start = seed % BRAINSTORM_POOL.len();
        for offset in 0..BRAINSTORM_POOL.len() {
            if result.len() >= 3 {
                break;
            }
            let i = (start + offset) % BRAINSTORM_POOL.len();
            let (key, label, prompt) = BRAINSTORM_POOL[i];
            // Threshold keys never collide with brainstorm keys (different
            // vocabularies), but check defensively anyway.
            if result.iter().any(|s| s.key == key) {
                continue;
            }
            result.push(ToneSuggestion {
                key: key.into(),
                label: label.into(),
                trigger: prompt.into(),
            });
        }
    }

    result
}
