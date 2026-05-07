// Refusal-shape strategy — the v0.1 adaptive probe state machine.
//
// State: a Hypothesis tracks the current category + per-framing
// observations.
// Action: pick the next probe from the category's bank in the active
// flavour. Selection mode is per-axis:
//   - if Settings.probe_selection has a probe-name for this axis, that
//     specific probe is returned (once);
//   - otherwise (or when the value is "random") a uniformly random
//     unused probe is drawn from the bank.
// Update: each Ollama classification updates the hypothesis.
// Terminate: 1 probe (thin) or up to 3 probes (full) per category, OR budget.

use crate::probes::probes_for_category;
use crate::schema::{FlavourConfig, Probe, ProbeOutcome, ResponseCategory, TopicVerdict};
use rand::seq::SliceRandom;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Hypothesis {
    pub class: String,
    pub framings_used: Vec<String>,
    pub categories_seen: Vec<ResponseCategory>,
    /// Probe names already returned for this axis. Used to avoid
    /// repetition within a single run when the strategy asks for
    /// multiple probes (full-refresh mode).
    pub names_used: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Observation {
    pub framing: String,
    pub category: ResponseCategory,
}

pub struct RefusalShapeStrategy<'a> {
    pub thin_mode: bool,
    pub flavour: &'a FlavourConfig,
    pub probe_selection: &'a HashMap<String, String>,
}

impl<'a> RefusalShapeStrategy<'a> {
    pub fn new(
        thin_mode: bool,
        flavour: &'a FlavourConfig,
        probe_selection: &'a HashMap<String, String>,
    ) -> Self {
        Self { thin_mode, flavour, probe_selection }
    }

    pub fn initial_hypothesis(&self, class: String) -> Hypothesis {
        Hypothesis {
            class,
            framings_used: Vec::new(),
            categories_seen: Vec::new(),
            names_used: Vec::new(),
        }
    }

    pub fn next_probe(&self, h: &Hypothesis, _obs: &[Observation]) -> Option<Probe> {
        let bank = probes_for_category(self.flavour, &h.class);
        if bank.is_empty() {
            return None;
        }

        // If the user has pinned a specific probe by name for this axis,
        // honour the pin on the FIRST pick. After that we draw randomly
        // from the remaining unused probes (full-refresh mode only —
        // thin-mode terminates after 1 probe so this code never runs there).
        let pin = self
            .probe_selection
            .get(&h.class)
            .map(String::as_str)
            .filter(|s| !s.is_empty() && *s != "random");

        if let Some(pinned_name) = pin {
            if h.names_used.is_empty() {
                if let Some(p) = bank.iter().find(|p| p.name == pinned_name) {
                    return Some(p.clone());
                }
                tracing::warn!(
                    "probe pin '{}' for axis '{}' not found in flavour bank — falling through to random",
                    pinned_name, h.class
                );
            }
        }

        // Random pick from probes whose names haven't yet been used.
        let already: std::collections::HashSet<&str> =
            h.names_used.iter().map(String::as_str).collect();
        let unused: Vec<&Probe> = bank
            .iter()
            .filter(|p| !already.contains(p.name.as_str()))
            .collect();
        if unused.is_empty() {
            return None;
        }
        let mut rng = rand::thread_rng();
        unused.choose(&mut rng).map(|&p| p.clone())
    }

    pub fn update(&self, h: &mut Hypothesis, obs: &Observation) {
        h.framings_used.push(obs.framing.clone());
        h.categories_seen.push(obs.category.clone());
    }

    /// Mark a probe-name as used so the next draw won't repeat it.
    /// Called by the runner alongside `update` after each probe outcome.
    pub fn note_probe_used(&self, h: &mut Hypothesis, probe_name: &str) {
        h.names_used.push(probe_name.to_string());
    }

    pub fn is_terminated(&self, h: &Hypothesis, _obs: &[Observation]) -> bool {
        if self.thin_mode {
            // 1 probe per category in calibration thin mode.
            h.framings_used.len() >= 1
        } else {
            // Full refresh: up to 3 probes per category.
            h.framings_used.len() >= 3
        }
    }

    pub fn finalize(
        &self,
        class: &str,
        h: &Hypothesis,
        outcomes: &[ProbeOutcome],
    ) -> (TopicVerdict, Option<String>, String) {
        crate::rules::refusal_rules::aggregate(self.flavour, class, h, outcomes)
    }
}
