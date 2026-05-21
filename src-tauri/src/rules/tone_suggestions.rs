// Stage 2 — Suggested tones for the composer.
//
// Reads the current fingerprint (per-class verdicts + per-probe dials)
// and selects up to 3 tone suggestions from a fixed vocabulary of 5.
//
// Architecturally R-layer: deterministic, no ML, no LLM. Same fingerprint
// produces the same suggestions every time. The frontend renders the
// returned suggestions as clickable pills near the composer; clicking a
// pill inserts its `hint` into the composer textarea. The model never
// picks tones — the user does. This is the v0.1.3 first pass; vocabulary
// breadth, scoring weights, and update cadence are open for iteration.
//
// SDC fit: this is the R-layer extension named in `buffer.md` v0.1.3
// section — code reads recent rules-layer verdicts and dial averages
// and selects from a fixed vocabulary. Judgement stays in code; the
// LLM never selects a tone.

use crate::schema::{Fingerprint, ToneSuggestion, TopicVerdict};

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
                hint: "Push back harder: ".into(),
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
                hint: "Drop the social affect and just state the position: ".into(),
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
                hint: "I disagree. Be specific about what you think and why: ".into(),
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
                hint: "Be specific. Name exact cases, not generalities: ".into(),
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
                hint: "Don't try to please me — give me the answer you'd give a stranger: ".into(),
                trigger: format!("concession depth is {:.0}%", conc_avg * 100.0),
            },
        ));
    }

    // Sort by descending score; return at most 3. Deduplication by key
    // is implicit — each branch above produces at most one entry.
    candidates.sort_by(|a, b| {
        b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.into_iter().take(3).map(|(_, t)| t).collect()
}
