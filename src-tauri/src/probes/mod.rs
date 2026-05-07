// Probes module. Holds the runner and the refusal-shape strategy state
// machine. The probe bank itself now lives in the active flavour config
// (loaded from `flavours/<slug>.json`); the runner consults the flavour
// instead of inline Rust functions.

pub mod runner;
pub mod refusal_shape;

use crate::schema::{FlavourConfig, Probe};
use serde_json::{json, Value};

/// Returns the active flavour's probe bank as a JSON document, suitable
/// for the renderer's "Show full probe set" modal. Shape preserves the
/// legacy fields (version, language, classes/probes) so existing
/// renderer code continues to work.
pub fn probe_bank(flavour: &FlavourConfig) -> Value {
    let classes: Vec<Value> = flavour
        .categories
        .iter()
        .map(|cat| {
            let probes: Vec<Value> = cat
                .probes
                .iter()
                .map(|p| {
                    json!({
                        "name": p.name,
                        "framing": p.framing,
                        "prompt": p.prompt,
                    })
                })
                .collect();
            json!({
                "class": cat.slug,
                "display_name": cat.display_name,
                "icon": cat.icon,
                "description": cat.description,
                "probes": probes,
            })
        })
        .collect();

    json!({
        "version": flavour.flavour_version,
        "flavour": flavour.slug,
        "language": flavour.language,
        "classes": classes,
    })
}

/// Vec<Probe> for one category in the active flavour. Used by the
/// refusal-shape strategy when picking the next probe.
pub fn probes_for_category(flavour: &FlavourConfig, category_slug: &str) -> Vec<Probe> {
    flavour
        .categories
        .iter()
        .find(|c| c.slug == category_slug)
        .map(|c| {
            c.probes
                .iter()
                .map(|p| Probe {
                    class: category_slug.to_string(),
                    name: p.name.clone(),
                    framing: p.framing.clone(),
                    prompt: p.prompt.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}
