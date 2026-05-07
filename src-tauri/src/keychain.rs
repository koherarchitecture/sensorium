// OS-native credential storage with encrypted-file fallback.
//
// Primary path: OS keychain (libsecret on Linux, Keychain.app on macOS,
// Credential Manager on Windows) via the `keyring` crate. Works on every
// real desktop install — Ubuntu via gdm-unlocked login keyring, macOS
// out of the box, Windows similarly.
//
// Fallback path: ChaCha20-Poly1305 AEAD-encrypted file at
// `<app_config>/credentials.enc` with a per-install random 32-byte key
// stored at `<app_config>/credentials.key`. Used when the OS keychain
// isn't available — minimal Linux installs without a Secret Service,
// WSL, headless servers, fresh containers, etc.
//
// The fallback is engaged transparently: callers don't know which path
// was used. If the OS keychain works, it is used. If `set` fails on the
// keychain or `get` returns "no collection / not available", the file
// path takes over.
//
// Threat model the fallback addresses:
//   • casual filesystem inspection — encrypted at rest with AEAD, not
//     defeated by `cat ~/.config/.../credentials.enc | grep`
// Threat model it does NOT address:
//   • untrusted user-process running as the same user — same as macOS
//     keychain when the device is unlocked; out of scope locally
//   • disk image moved to another machine — out of scope for v0.1.x
//
// API stays the same as before; the new `*_at` variants accept the
// app config dir for the file fallback. The bare functions assume the
// keychain works; new callers should prefer the `*_at` variants.

use anyhow::{Context, Result};
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    ChaCha20Poly1305, Nonce,
};
use keyring::Entry;
use rand::RngCore;
use std::fs;
use std::path::{Path, PathBuf};

const SERVICE: &str = "sensorium";
const ACCOUNT_OPENROUTER: &str = "openrouter";

const FALLBACK_KEY_FILE: &str = "credentials.key";
const FALLBACK_DATA_FILE: &str = "credentials.enc";

// ── Public API (with fallback awareness) ─────────────────────────────

pub fn set_openrouter_key(key: &str, app_config_dir: Option<&Path>) -> Result<()> {
    match Entry::new(SERVICE, ACCOUNT_OPENROUTER).and_then(|e| e.set_password(key)) {
        Ok(()) => Ok(()),
        Err(e) => {
            tracing::warn!(
                "OS keychain unavailable ({e}); falling back to encrypted file storage"
            );
            match app_config_dir {
                Some(dir) => fallback_set(dir, key),
                None => Err(anyhow::anyhow!("keychain set: {e}")),
            }
        }
    }
}

pub fn get_openrouter_key(app_config_dir: Option<&Path>) -> Result<Option<String>> {
    let entry_result = Entry::new(SERVICE, ACCOUNT_OPENROUTER).and_then(|e| e.get_password());
    match entry_result {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => {
            // Keychain accepted us but had no entry. Still try the fallback
            // file in case a previous session went down the fallback path.
            match app_config_dir {
                Some(dir) => fallback_get(dir),
                None => Ok(None),
            }
        }
        Err(e) => {
            tracing::warn!(
                "OS keychain read failed ({e}); trying encrypted file fallback"
            );
            match app_config_dir {
                Some(dir) => fallback_get(dir),
                None => Err(anyhow::anyhow!("keychain get: {e}")),
            }
        }
    }
}

pub fn clear_openrouter_key(app_config_dir: Option<&Path>) -> Result<()> {
    // Best-effort clear from BOTH stores, since either could hold the value.
    let mut errors: Vec<String> = Vec::new();
    if let Ok(entry) = Entry::new(SERVICE, ACCOUNT_OPENROUTER) {
        match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => {}
            Err(e) => errors.push(format!("keychain delete: {e}")),
        }
    }
    if let Some(dir) = app_config_dir {
        if let Err(e) = fallback_clear(dir) {
            errors.push(format!("fallback file delete: {e}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else if errors.len() == 1 {
        Err(anyhow::anyhow!("{}", errors[0]))
    } else {
        Err(anyhow::anyhow!("multiple delete errors: {}", errors.join("; ")))
    }
}

// ── Encrypted-file fallback ──────────────────────────────────────────

fn fallback_key_path(dir: &Path) -> PathBuf {
    dir.join(FALLBACK_KEY_FILE)
}

fn fallback_data_path(dir: &Path) -> PathBuf {
    dir.join(FALLBACK_DATA_FILE)
}

/// Load the per-install ChaCha20 key, or generate one if missing. The key
/// file lives in the same directory as `preferences.json` and is created
/// with `0600` permissions where the platform supports it.
fn load_or_create_fallback_key(dir: &Path) -> Result<[u8; 32]> {
    let key_path = fallback_key_path(dir);
    if key_path.exists() {
        let raw = fs::read(&key_path)
            .with_context(|| format!("read fallback key at {}", key_path.display()))?;
        if raw.len() != 32 {
            anyhow::bail!(
                "fallback key file at {} has wrong length ({}, expected 32)",
                key_path.display(),
                raw.len()
            );
        }
        let mut k = [0u8; 32];
        k.copy_from_slice(&raw);
        return Ok(k);
    }

    if let Some(parent) = key_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create config dir {}", parent.display()))?;
    }

    let mut k = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut k);
    fs::write(&key_path, k)
        .with_context(|| format!("write fallback key at {}", key_path.display()))?;
    set_owner_only_perms(&key_path);
    tracing::info!("created fallback credentials key at {}", key_path.display());
    Ok(k)
}

fn fallback_set(dir: &Path, secret: &str) -> Result<()> {
    let key = load_or_create_fallback_key(dir)?;
    let cipher = ChaCha20Poly1305::new_from_slice(&key)
        .map_err(|e| anyhow::anyhow!("init cipher: {e}"))?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, secret.as_bytes())
        .map_err(|e| anyhow::anyhow!("encrypt: {e}"))?;

    // File layout: [12-byte nonce][ciphertext+16-byte tag]
    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);

    let data_path = fallback_data_path(dir);
    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create config dir {}", parent.display()))?;
    }
    fs::write(&data_path, out)
        .with_context(|| format!("write fallback data at {}", data_path.display()))?;
    set_owner_only_perms(&data_path);
    Ok(())
}

fn fallback_get(dir: &Path) -> Result<Option<String>> {
    let data_path = fallback_data_path(dir);
    if !data_path.exists() {
        return Ok(None);
    }
    let raw = fs::read(&data_path)
        .with_context(|| format!("read fallback data at {}", data_path.display()))?;
    if raw.len() < 12 + 16 {
        anyhow::bail!(
            "fallback data file at {} is too short ({})",
            data_path.display(),
            raw.len()
        );
    }
    let key = load_or_create_fallback_key(dir)?;
    let cipher = ChaCha20Poly1305::new_from_slice(&key)
        .map_err(|e| anyhow::anyhow!("init cipher: {e}"))?;
    let (nonce_bytes, ciphertext) = raw.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow::anyhow!("decrypt: {e}"))?;
    let s = String::from_utf8(plaintext).context("fallback decrypt produced non-UTF8")?;
    Ok(Some(s))
}

fn fallback_clear(dir: &Path) -> Result<()> {
    let data_path = fallback_data_path(dir);
    if data_path.exists() {
        fs::remove_file(&data_path)
            .with_context(|| format!("remove fallback data at {}", data_path.display()))?;
    }
    // Keep the per-install key file — still needed for subsequent set calls.
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(mut perms) = fs::metadata(path).map(|m| m.permissions()) {
        perms.set_mode(0o600);
        let _ = fs::set_permissions(path, perms);
    }
}
#[cfg(not(unix))]
fn set_owner_only_perms(_path: &Path) {
    // Windows credential ACLs aren't readily set from std::fs; the parent
    // dir's default ACL inherits "user-only" because it's under %APPDATA%.
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("sensorium-keychain-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fallback_round_trip() {
        let dir = tmp_dir("round-trip");
        fallback_set(&dir, "sk-or-v1-test-secret").unwrap();
        let got = fallback_get(&dir).unwrap();
        assert_eq!(got.as_deref(), Some("sk-or-v1-test-secret"));
        fallback_clear(&dir).unwrap();
        let cleared = fallback_get(&dir).unwrap();
        assert_eq!(cleared, None);
    }

    #[test]
    fn fallback_key_persists_across_writes() {
        let dir = tmp_dir("key-persists");
        fallback_set(&dir, "first").unwrap();
        let key1 = fs::read(fallback_key_path(&dir)).unwrap();
        fallback_set(&dir, "second").unwrap();
        let key2 = fs::read(fallback_key_path(&dir)).unwrap();
        assert_eq!(key1, key2, "per-install key should not regenerate per write");
        let got = fallback_get(&dir).unwrap();
        assert_eq!(got.as_deref(), Some("second"));
    }

    #[test]
    fn fallback_data_is_not_plaintext() {
        let dir = tmp_dir("not-plaintext");
        let secret = "sk-or-v1-grep-target";
        fallback_set(&dir, secret).unwrap();
        let raw = fs::read(fallback_data_path(&dir)).unwrap();
        let bytes_as_str = String::from_utf8_lossy(&raw);
        assert!(
            !bytes_as_str.contains(secret),
            "encrypted file should not contain the plaintext secret"
        );
    }

    #[test]
    fn fallback_get_with_no_file_returns_none() {
        let dir = tmp_dir("no-file");
        let got = fallback_get(&dir).unwrap();
        assert_eq!(got, None);
    }
}
