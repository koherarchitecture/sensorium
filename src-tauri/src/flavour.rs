// Flavour loader.
//
// Sensorium ships as flavours — JSON configs that fully specify a
// behavioural-posture probe set. The base engine loads exactly one
// flavour at runtime. The first flavour (and the only one bundled at
// engine v0.1) is `sycophancy`.
//
// Resolution order for a flavour slug:
//   1. <user-data>/flavours/<slug>.json  — user-installed or copied
//   2. <bundle>/flavours/<slug>.json     — shipped with the app
//
// The bundled file is copied to user-data on first run so the user
// can edit it (probe-set transparency / future in-app editing).
//
// This module is non-breaking: it adds a parallel path. The existing
// inline `probe_bank()` in probes/mod.rs keeps working until callers
// migrate to consume the loaded `FlavourConfig`.

use crate::schema::FlavourConfig;
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

/// The default flavour slug at engine v0.1.
pub const DEFAULT_FLAVOUR_SLUG: &str = "sycophancy";

/// Load a flavour by slug. Tries user-data first, then bundled fallback.
///
/// `user_data_dir` is typically `dirs::config_dir()` joined with
/// `Koher/Sensorium`. `bundle_resource_dir` is Tauri's resource dir
/// where bundled flavour JSONs live.
pub fn load_flavour(
    slug: &str,
    user_data_dir: Option<&Path>,
    bundle_resource_dir: Option<&Path>,
) -> Result<FlavourConfig> {
    // 1. user-data path
    if let Some(udir) = user_data_dir {
        let p = udir.join("flavours").join(format!("{slug}.json"));
        if p.exists() {
            return load_from_path(&p);
        }
    }
    // 2. bundle-resource path. Tauri prefixes resources that use `..`
    // in `tauri.conf.json > bundle.resources` with `_up_/` in the
    // bundle (path-collision protection — see Tauri's resource bundling
    // logic). Since our config specifies `"../flavours/*.json"`, the
    // actual on-disk path inside an installed .deb / .flatpak / .dmg is
    // `<resource_dir>/_up_/flavours/<slug>.json`. Try that first; fall
    // back to the plain `flavours/` path for any future bundling layout
    // that doesn't traverse a parent directory.
    if let Some(bdir) = bundle_resource_dir {
        let p_up = bdir
            .join("_up_")
            .join("flavours")
            .join(format!("{slug}.json"));
        if p_up.exists() {
            return load_from_path(&p_up);
        }
        let p = bdir.join("flavours").join(format!("{slug}.json"));
        if p.exists() {
            return load_from_path(&p);
        }
    }
    // 3. dev fallback: try several paths relative to where the binary runs.
    // `npx tauri dev` runs the binary from src-tauri/target/debug/, while
    // `cargo run` may run from src-tauri/ or the project root. Try each.
    let dev_candidates: [PathBuf; 4] = [
        ["flavours", &format!("{slug}.json")].iter().collect(),
        ["..", "flavours", &format!("{slug}.json")].iter().collect(),
        ["..", "..", "flavours", &format!("{slug}.json")].iter().collect(),
        ["..", "..", "..", "flavours", &format!("{slug}.json")].iter().collect(),
    ];
    for p in &dev_candidates {
        if p.exists() {
            return load_from_path(p);
        }
    }

    // 4. compile-time fallback: CARGO_MANIFEST_DIR points at src-tauri/,
    // so flavours/ lives one directory up. This works in `cargo run` and
    // tauri dev regardless of CWD.
    let manifest_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("flavours").join(format!("{slug}.json")));
    if let Some(p) = manifest_path {
        if p.exists() {
            return load_from_path(&p);
        }
    }

    anyhow::bail!(
        "flavour '{slug}' not found in user-data, bundle resources, dev fallback, or manifest-relative fallback"
    )
}

fn load_from_path(p: &Path) -> Result<FlavourConfig> {
    let raw = fs::read_to_string(p)
        .with_context(|| format!("reading flavour file at {}", p.display()))?;
    let cfg: FlavourConfig = serde_json::from_str(&raw)
        .with_context(|| format!("parsing flavour JSON at {}", p.display()))?;
    validate_flavour(&cfg)?;
    Ok(cfg)
}

fn validate_flavour(cfg: &FlavourConfig) -> Result<()> {
    if cfg.schema_version != "1" {
        anyhow::bail!(
            "unsupported flavour schema_version: {} (engine supports '1')",
            cfg.schema_version
        );
    }
    if cfg.slug.is_empty() {
        anyhow::bail!("flavour slug is empty");
    }
    if cfg.categories.is_empty() {
        anyhow::bail!("flavour '{}' has no categories", cfg.slug);
    }
    for cat in &cfg.categories {
        if cat.probes.is_empty() {
            anyhow::bail!(
                "flavour '{}' category '{}' has no probes",
                cfg.slug,
                cat.slug
            );
        }
    }
    if cfg.verdict_vocabulary.per_category.is_empty() {
        anyhow::bail!(
            "flavour '{}' has empty per_category verdict vocabulary",
            cfg.slug
        );
    }
    Ok(())
}

/// Copy a bundled flavour file into the user-data flavours directory
/// if the user-data version is missing. Used at first run.
pub fn ensure_flavour_in_user_data(
    slug: &str,
    user_data_dir: &Path,
    bundle_resource_dir: &Path,
) -> Result<()> {
    let user_path = user_data_dir.join("flavours").join(format!("{slug}.json"));
    if user_path.exists() {
        return Ok(());
    }
    // Same `_up_/` mangling as in load_flavour above — Tauri's bundle
    // logic prefixes resources that use `..` in the config. Check the
    // `_up_/flavours/` path first, fall back to plain `flavours/`.
    let bundle_path_up = bundle_resource_dir
        .join("_up_")
        .join("flavours")
        .join(format!("{slug}.json"));
    let bundle_path = if bundle_path_up.exists() {
        bundle_path_up
    } else {
        bundle_resource_dir
            .join("flavours")
            .join(format!("{slug}.json"))
    };
    if !bundle_path.exists() {
        anyhow::bail!(
            "cannot seed flavour '{slug}' — bundle file missing at {}",
            bundle_path.display()
        );
    }
    fs::create_dir_all(user_path.parent().unwrap())?;
    fs::copy(&bundle_path, &user_path).with_context(|| {
        format!(
            "copying bundled flavour from {} to {}",
            bundle_path.display(),
            user_path.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_dev_fallback_sycophancy() {
        // This test runs when cargo test is invoked from the repo root
        // where the flavours/ folder is present. CI may need to skip.
        let dev_path: PathBuf = ["flavours", "sycophancy.json"].iter().collect();
        if !dev_path.exists() {
            eprintln!("skipping: flavours/sycophancy.json not present from CWD");
            return;
        }
        let cfg = load_flavour("sycophancy", None, None).expect("load");
        assert_eq!(cfg.slug, "sycophancy");
        assert_eq!(cfg.schema_version, "1");
        assert!(!cfg.categories.is_empty());
    }
}
