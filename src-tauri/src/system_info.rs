// System info — used to recommend an Ollama model that fits the
// user's machine without thrashing.
//
// Sensorium is sized for 8 GB minimum; recommendations scale up
// when more RAM is available. The Q-layer classifier model is the
// only ML Sensorium consumes; bigger ≠ always better, but does help
// with the templated-vs-redirect distinction.

use serde::{Deserialize, Serialize};
use sysinfo::System;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub total_ram_gb: f64,
    pub available_ram_gb: f64,
    pub physical_cores: u32,
    pub os_name: String,
    pub os_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaRecommendation {
    /// The model tag to pull (`ollama pull <tag>`).
    pub tag: String,
    /// Human-readable model display name.
    pub display_name: String,
    /// Approx. resident memory when loaded, in GB.
    pub resident_size_gb: f64,
    /// Tier label shown to the user — "lean" / "standard" / "strong".
    pub tier: &'static str,
    /// One-line reason this recommendation is appropriate for the machine.
    pub rationale: String,
    /// Available alternative tiers the user can choose instead.
    pub alternatives: Vec<OllamaAlternative>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaAlternative {
    pub tag: String,
    pub display_name: String,
    pub resident_size_gb: f64,
    pub tier: &'static str,
    pub note: String,
}

/// Capture system info synchronously.
pub fn capture() -> SystemInfo {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();

    let total_ram_gb = (sys.total_memory() as f64) / 1_073_741_824.0; // bytes → GB
    let available_ram_gb = (sys.available_memory() as f64) / 1_073_741_824.0;

    SystemInfo {
        total_ram_gb,
        available_ram_gb,
        physical_cores: sys.physical_core_count().unwrap_or(0) as u32,
        os_name: System::name().unwrap_or_else(|| "Unknown".to_string()),
        os_version: System::os_version().unwrap_or_else(|| "Unknown".to_string()),
    }
}

/// Recommend an Ollama model based on total RAM.
///
/// Tiers (designed for 8 GB baseline, scaling up):
///
/// | Total RAM | Recommended | Resident | Tier      |
/// |-----------|-------------|----------|-----------|
/// | < 8 GB    | qwen2.5:0.5b| ~0.4 GB  | minimal   |
/// | 8–12 GB   | qwen2.5:1.5b| ~1.0 GB  | lean      |
/// | 12–24 GB  | qwen2.5:3b  | ~2.0 GB  | standard  |
/// | ≥ 24 GB   | qwen2.5:7b  | ~4.5 GB  | strong    |
///
/// Why these tiers:
/// - All Qwen 2.5 family for consistent JSON-following behaviour
///   (the classifier returns a fixed JSON shape — Qwen 2.5 is one
///   of the strongest small-model families at structured output).
/// - Sub-1B (0.5b) is a fallback for very constrained machines —
///   classification quality drops on the templated-vs-redirect edge
///   case but headline verdicts (refusal / substantive) stay reliable.
/// - 1.5B is the default for 8 GB: ~1 GB resident leaves ~3 GB
///   headroom on a typical 8 GB machine after macOS + browser + editor.
/// - 3B is the standard for 12–16 GB+: notably better on edge-case
///   classification (templated vs redirect), still well within budget.
/// - 7B is the strong tier for 24 GB+: highest classification fidelity
///   the task benefits from. Bigger models give diminishing returns
///   for what is fundamentally a 5-class classification task.
pub fn recommend_ollama(info: &SystemInfo) -> OllamaRecommendation {
    let ram = info.total_ram_gb;

    if ram >= 24.0 {
        OllamaRecommendation {
            tag: "qwen2.5:7b".into(),
            display_name: "Qwen 2.5 — 7B".into(),
            resident_size_gb: 4.5,
            tier: "strong",
            rationale: format!(
                "Your machine has ≈{:.0} GB RAM. The 7B model leaves \
                 plenty of headroom and gives the highest classification \
                 fidelity available for this task.",
                ram
            ),
            alternatives: vec![
                alt_1_5b("Lighter — frees more RAM for other work."),
                alt_3b("Mid-tier — good balance if you want to give other apps more headroom."),
            ],
        }
    } else if ram >= 12.0 {
        OllamaRecommendation {
            tag: "qwen2.5:3b".into(),
            display_name: "Qwen 2.5 — 3B".into(),
            resident_size_gb: 2.0,
            tier: "standard",
            rationale: format!(
                "Your machine has ≈{:.0} GB RAM. The 3B model fits \
                 comfortably and gives notably better classification on \
                 edge cases (templated-vs-redirect distinction).",
                ram
            ),
            alternatives: vec![
                alt_1_5b("Lighter — runs faster, slightly coarser classification."),
                alt_7b_with_caveat(ram, "Larger — may pressure RAM if you run heavy apps alongside."),
            ],
        }
    } else if ram >= 7.0 {
        OllamaRecommendation {
            tag: "qwen2.5:1.5b".into(),
            display_name: "Qwen 2.5 — 1.5B".into(),
            resident_size_gb: 1.0,
            tier: "lean",
            rationale: format!(
                "Your machine has ≈{:.0} GB RAM. The 1.5B model leaves \
                 comfortable headroom for a browser, editor, and chat \
                 alongside Sensorium. Classification quality is reliable \
                 for headline verdicts.",
                ram
            ),
            alternatives: vec![
                alt_0_5b("Minimal — fastest, coarsest classification. Use if RAM is constrained."),
                alt_3b_with_caveat(ram, "Better quality — but check that other apps aren't competing for memory."),
            ],
        }
    } else {
        OllamaRecommendation {
            tag: "qwen2.5:0.5b".into(),
            display_name: "Qwen 2.5 — 0.5B".into(),
            resident_size_gb: 0.4,
            tier: "minimal",
            rationale: format!(
                "Your machine has ≈{:.1} GB RAM. The 0.5B model is the \
                 lightest fit. Classification is reliable for headline \
                 verdicts but coarser on edge cases.",
                ram
            ),
            alternatives: vec![
                alt_1_5b_with_caveat(ram, "Better quality — only if you can free memory by closing other apps."),
            ],
        }
    }
}

// Alternative-tier helpers — keep recommendation surface honest.

fn alt_0_5b(note: &str) -> OllamaAlternative {
    OllamaAlternative {
        tag: "qwen2.5:0.5b".into(),
        display_name: "Qwen 2.5 — 0.5B".into(),
        resident_size_gb: 0.4,
        tier: "minimal",
        note: note.into(),
    }
}

fn alt_1_5b(note: &str) -> OllamaAlternative {
    OllamaAlternative {
        tag: "qwen2.5:1.5b".into(),
        display_name: "Qwen 2.5 — 1.5B".into(),
        resident_size_gb: 1.0,
        tier: "lean",
        note: note.into(),
    }
}

fn alt_1_5b_with_caveat(_ram: f64, note: &str) -> OllamaAlternative {
    alt_1_5b(note)
}

fn alt_3b(note: &str) -> OllamaAlternative {
    OllamaAlternative {
        tag: "qwen2.5:3b".into(),
        display_name: "Qwen 2.5 — 3B".into(),
        resident_size_gb: 2.0,
        tier: "standard",
        note: note.into(),
    }
}

fn alt_3b_with_caveat(_ram: f64, note: &str) -> OllamaAlternative {
    alt_3b(note)
}

fn alt_7b_with_caveat(_ram: f64, note: &str) -> OllamaAlternative {
    OllamaAlternative {
        tag: "qwen2.5:7b".into(),
        display_name: "Qwen 2.5 — 7B".into(),
        resident_size_gb: 4.5,
        tier: "strong",
        note: note.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_sys(ram_gb: f64) -> SystemInfo {
        SystemInfo {
            total_ram_gb: ram_gb,
            available_ram_gb: ram_gb * 0.5,
            physical_cores: 8,
            os_name: "Darwin".into(),
            os_version: "26.0".into(),
        }
    }

    #[test]
    fn rec_for_8gb_is_lean() {
        let r = recommend_ollama(&fake_sys(8.0));
        assert_eq!(r.tag, "qwen2.5:1.5b");
        assert_eq!(r.tier, "lean");
    }

    #[test]
    fn rec_for_16gb_is_standard() {
        let r = recommend_ollama(&fake_sys(16.0));
        assert_eq!(r.tag, "qwen2.5:3b");
        assert_eq!(r.tier, "standard");
    }

    #[test]
    fn rec_for_32gb_is_strong() {
        let r = recommend_ollama(&fake_sys(32.0));
        assert_eq!(r.tag, "qwen2.5:7b");
        assert_eq!(r.tier, "strong");
    }

    #[test]
    fn rec_for_4gb_is_minimal() {
        let r = recommend_ollama(&fake_sys(4.0));
        assert_eq!(r.tag, "qwen2.5:0.5b");
        assert_eq!(r.tier, "minimal");
    }
}
