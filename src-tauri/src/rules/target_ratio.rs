// target_ratio.rs — deterministic helpers for the user's target ratio.
//
// The *target ratio* is the user's chosen goal for conversations with
// the model — the proportion at which they want the conversation to sit
// on the canon's split / conflated axis. Stored as the *held* side on a
// 1–9 scale; the conflated side is implied (`10 - held`).
//
// This module owns the vocabulary rules:
//   • Validation (canon clamp: 1–9 only; 0 and 10 are excluded by
//     design — see splitdomaincognition.org/split-ratio for why).
//   • Format helpers (held: u8 → "N:M" string).
//   • Direction tag (held-leaning / balanced / conflated-leaning) for UI
//     coaching cues without importing optimisation register.
//
// What this module is NOT:
//   • Not the sensed-split computation. That arrives with the
//     Fingerprint-driven sensed split in a later v0.1.7 increment.
//   • Not the practitioner's self-rated split ratio. The canon reserves
//     that phrase for the practitioner's reading of a *published
//     artefact*; an instrument never produces it.
//
// Canon reference (rule 5, "Name itself clearly in the UI"): never
// label the target ratio "your split ratio" or "the split ratio". It
// is a goal the user defines; the canon's noun belongs to a different
// register the instrument cannot occupy.

/// Inclusive lower bound for the held side of the target ratio.
pub const MIN_HELD: u8 = 1;

/// Inclusive upper bound for the held side of the target ratio.
pub const MAX_HELD: u8 = 9;

/// Default target ratio when no preference has been set (`7:3` —
/// held-leaning, the position most practitioners pick as their default
/// in early co-production sessions).
pub const DEFAULT_HELD: u8 = 7;

/// True iff the supplied held value sits in the canon's configurable
/// range [1, 9]. The endpoints 0 and 10 are deliberately excluded — see
/// the canon doc for the reasoning ("no real conversation cleanly
/// achieves either pole").
pub fn is_valid_held(held: u8) -> bool {
    held >= MIN_HELD && held <= MAX_HELD
}

/// Clamp a raw held value into the canon's range. Used at boundaries
/// where untrusted input arrives (renderer slider, deserialised config).
pub fn clamp_held(held: u8) -> u8 {
    held.clamp(MIN_HELD, MAX_HELD)
}

/// Render the held value as a canonical `N:M` string (e.g., `7:3`).
pub fn format_ratio(held: u8) -> String {
    let h = clamp_held(held);
    let conflated = 10 - h;
    format!("{}:{}", h, conflated)
}

/// Human-readable direction tag — for use in coaching strips and the
/// preferences pane. Three tiers, no optimisation register:
///
/// * `held-leaning` — held side ≥ 6
/// * `balanced` — held side == 5
/// * `conflated-leaning` — held side ≤ 4
pub fn direction_tag(held: u8) -> &'static str {
    let h = clamp_held(held);
    if h >= 6 {
        "held-leaning"
    } else if h == 5 {
        "balanced"
    } else {
        "conflated-leaning"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_inside_range() {
        for h in 1..=9 {
            assert!(is_valid_held(h), "expected {} to validate", h);
        }
    }

    #[test]
    fn rejects_endpoints_and_overflow() {
        assert!(!is_valid_held(0));
        assert!(!is_valid_held(10));
        assert!(!is_valid_held(255));
    }

    #[test]
    fn clamp_pulls_into_range() {
        assert_eq!(clamp_held(0), 1);
        assert_eq!(clamp_held(10), 9);
        assert_eq!(clamp_held(5), 5);
    }

    #[test]
    fn format_renders_n_m() {
        assert_eq!(format_ratio(7), "7:3");
        assert_eq!(format_ratio(1), "1:9");
        assert_eq!(format_ratio(9), "9:1");
        // Out-of-range input clamps into range before formatting.
        assert_eq!(format_ratio(0), "1:9");
        assert_eq!(format_ratio(10), "9:1");
    }

    #[test]
    fn direction_tag_buckets() {
        assert_eq!(direction_tag(9), "held-leaning");
        assert_eq!(direction_tag(6), "held-leaning");
        assert_eq!(direction_tag(5), "balanced");
        assert_eq!(direction_tag(4), "conflated-leaning");
        assert_eq!(direction_tag(1), "conflated-leaning");
    }
}
