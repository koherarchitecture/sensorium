// Stage 2 — Suggested tones for the composer.
//
// Always returns 3 tone suggestions whenever a fingerprint with probes
// exists. The cues are brainstorming prompts — model-agnostic moves the
// user can take in their next message — combined with pattern cues that
// fire when the model's behaviour pushes against the user's chosen
// target ratio.
//
// v0.1.7 — gap-driven cue selection.
// The user defines a *target ratio* (Settings::target_split_held); the
// engine senses where the conversation actually sits via the sensed-split
// register; this module reads the gap and surfaces cues that help the
// user work toward their target.
//
//   • Within delta=1 of the target → silence (return zero pattern cues;
//     brainstorm pool still fills slots when the row is otherwise empty).
//     "Silence is signal" — the conversation is in the user's band; the
//     tool stops talking. Pre-dev notes §6.3.
//   • Sensed below target (conversation more conflated than goal) →
//     pull-toward-held cues (the original five-vocabulary from v0.1.3).
//   • Sensed above target (conversation more disciplined than goal) →
//     soften cues (the rarer above-target direction; bidirectional
//     coaching per pre-dev notes §6.3 + §8.2 binding addition).
//
// When target / sensed-split signals are unavailable (legacy callers,
// missing flavour mapping, empty fingerprint), the function falls back
// to the pre-v0.1.7 fingerprint-only threshold derivation so old code
// paths keep working unchanged.
//
// Architecturally R-layer: deterministic, no ML, no LLM. Same inputs
// produce the same suggestions every time (the brainstorm rotation seed
// is derived from the fingerprint's dial sums).
//
// Design intent (binding user direction, 21 May 2026 late evening):
// "tone suggestions should always work with any model. it is for
// brainstorming." Threshold cues take priority when they fire;
// brainstorm cues fill the remaining slots so the row always carries
// three useful prompts. The cues are never clickable (binding user
// direction, 21 May 2026: "I will never want click to insert — remove
// the feature"); the `hint` field that briefly existed on
// ToneSuggestion has been removed.

use crate::schema::{Fingerprint, SensedSplit, ToneSuggestion, TopicVerdict};

/// Delta on the 10-point scale within which the sensed split is treated
/// as "at target" and pattern cues fall silent. Pre-dev notes §6.3
/// working preference. Brainstorm cues still fill the row when otherwise
/// empty — silence here means the *pattern* cues fall silent, not all
/// cues.
const TARGET_DELTA: i32 = 1;

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

// Above-target soften vocabulary (v0.1.7). Surfaces when the sensed
// split sits *above* the user's target — the rarer case where the
// conversation is more disciplined than the user wanted. Pre-dev notes
// §6.3 + §8.2: bidirectional coaching needs candidates on both sides.
const SOFTEN_POOL: &[(&str, &str, &str)] = &[
    ("try-softer-frame",   "Try a softer frame",  "rephrase the same prompt with less edge"),
    ("ask-open-question",  "Ask an open question", "leave room for the model to wander"),
    ("invite-speculation", "Invite speculation",   "ask for a guess, not a fact"),
    ("ease-stakes",        "Ease the stakes",      "lower the framing pressure on the model"),
    ("open-aperture",      "Open the aperture",    "widen what counts as a useful answer"),
];

pub fn derive(
    fingerprint: &Fingerprint,
    target_held: Option<u8>,
    sensed: Option<&SensedSplit>,
) -> Vec<ToneSuggestion> {
    if fingerprint.classes.is_empty() {
        return Vec::new();
    }

    // v0.1.7 gap-driven path. When both target + sensed signals are
    // available, the cue direction is governed by their gap rather than
    // raw thresholds — same vocabulary, but selection is goal-aware.
    if let (Some(t), Some(s)) = (target_held, sensed) {
        let gap = s.held as i32 - t as i32;
        // Within delta → pattern cues fall silent; the brainstorm pool
        // still fills the row (the user gets prompts; the tool just
        // stops nagging in a particular direction).
        if gap.abs() <= TARGET_DELTA {
            return fill_with_brainstorm(Vec::new(), fingerprint, /* above_target */ false);
        }
        // Sensed below target → conversation more conflated than goal →
        // pull toward held with the existing five-vocabulary.
        if gap < 0 {
            let pattern = pull_toward_held(fingerprint);
            return fill_with_brainstorm(pattern, fingerprint, /* above_target */ false);
        }
        // Sensed above target → conversation more disciplined than goal →
        // pull toward conflated with the soften vocabulary.
        let pattern = pull_toward_conflated(fingerprint);
        return fill_with_brainstorm(pattern, fingerprint, /* above_target */ true);
    }

    // Pre-v0.1.7 fallback path — fingerprint-only thresholds, used when
    // target / sensed signals are unavailable (legacy callers, missing
    // flavour mapping). Same vocabulary as v0.1.3, behaviour unchanged.
    let pattern = pull_toward_held(fingerprint);
    fill_with_brainstorm(pattern, fingerprint, /* above_target */ false)
}

// Pull-toward-held threshold cues (the v0.1.3 five-vocabulary). Selected
// when the sensed split is below the user's target — the conversation
// is more conflated than the user's goal, and these cues push the user
// to demand more of the model.
fn pull_toward_held(fingerprint: &Fingerprint) -> Vec<ToneSuggestion> {

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
    candidates.into_iter().take(3).map(|(_, t)| t).collect()
}

// Pull-toward-conflated soften cues (v0.1.7). Selected when the sensed
// split sits *above* the user's target — the conversation is more
// disciplined than the user wanted. The asymmetric case from pre-dev
// notes §6.3: most users will pick held-leaning targets, but some
// conversations want looser; the engine has to support both directions.
//
// Threshold model is simpler than the held-direction side because the
// cues are inherently invitational, not corrective. We pick based on
// where the *least* discipline-pressure sits — high dial averages mean
// the conversation is already under pressure and adding more soften
// might over-correct, so we pick from the SOFTEN_POOL via the brainstorm
// rotation seed rather than a threshold scoreboard.
fn pull_toward_conflated(fingerprint: &Fingerprint) -> Vec<ToneSuggestion> {
    let (capit_sum, hedge_sum, affirm_sum, conc_sum, probe_count) =
        dial_sums(fingerprint);
    if probe_count == 0 {
        return Vec::new();
    }
    let seed = brainstorm_seed(capit_sum, hedge_sum, affirm_sum, conc_sum);
    let start = seed % SOFTEN_POOL.len();
    let mut out = Vec::with_capacity(3);
    for offset in 0..SOFTEN_POOL.len() {
        if out.len() >= 3 {
            break;
        }
        let (key, label, prompt) = SOFTEN_POOL[(start + offset) % SOFTEN_POOL.len()];
        out.push(ToneSuggestion {
            key: key.into(),
            label: label.into(),
            trigger: prompt.into(),
        });
    }
    out
}

// Fill remaining slots from the brainstorm pool so the row always
// carries 3 cues whenever a real fingerprint is available — not
// dependent on threshold crossings or gap direction. Pool rotation
// seed is a simple integer hash of the dial sums; same fingerprint →
// same brainstorm picks (deterministic, no flicker).
//
// When `above_target` is true (sensed split above target), the soften
// pool is preferred over the general brainstorm pool — the cues then
// stay register-consistent with the pull_toward_conflated direction.
fn fill_with_brainstorm(
    mut result: Vec<ToneSuggestion>,
    fingerprint: &Fingerprint,
    above_target: bool,
) -> Vec<ToneSuggestion> {
    if result.len() >= 3 {
        return result;
    }
    let (capit_sum, hedge_sum, affirm_sum, conc_sum, probe_count) =
        dial_sums(fingerprint);
    if probe_count == 0 {
        return result;
    }
    let pool: &[(&str, &str, &str)] = if above_target { SOFTEN_POOL } else { BRAINSTORM_POOL };
    let seed = brainstorm_seed(capit_sum, hedge_sum, affirm_sum, conc_sum);
    let start = seed % pool.len();
    for offset in 0..pool.len() {
        if result.len() >= 3 {
            break;
        }
        let (key, label, prompt) = pool[(start + offset) % pool.len()];
        if result.iter().any(|s| s.key == key) {
            continue;
        }
        result.push(ToneSuggestion {
            key: key.into(),
            label: label.into(),
            trigger: prompt.into(),
        });
    }
    result
}

fn dial_sums(fingerprint: &Fingerprint) -> (f64, f64, f64, f64, u32) {
    let mut capit_sum = 0.0_f64;
    let mut hedge_sum = 0.0_f64;
    let mut affirm_sum = 0.0_f64;
    let mut conc_sum = 0.0_f64;
    let mut probe_count = 0u32;
    for class in &fingerprint.classes {
        for probe in &class.probes {
            capit_sum += probe.dials.capit;
            hedge_sum += probe.dials.hedge;
            affirm_sum += probe.dials.affirm;
            conc_sum += probe.dials.conc;
            probe_count += 1;
        }
    }
    (capit_sum, hedge_sum, affirm_sum, conc_sum, probe_count)
}

fn brainstorm_seed(c: f64, h: f64, a: f64, x: f64) -> usize {
    ((c * 1000.0 + h * 100.0 + a * 10.0 + x) as i64).unsigned_abs() as usize
}
