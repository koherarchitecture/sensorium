# Packaging — Sensorium

Two release artefacts for Linux at v0.1: an Ubuntu LTS `.deb` (Tauri-native) and a self-hosted `.flatpak` (wraps the deb payload via `flatpak-builder`).

Spec reference: `../../spec.md` §13.2.2 (Linux packaging) and §13.4 (Distribution).

---

## What lives here

```
packaging/
├── README.md                          ← this file
└── flatpak/
    └── app.koher.sensorium.yml        ← flatpak-builder manifest
```

The flatpak manifest is the only file under version control here. Build outputs land in `../dist/`:

```
sensorium/dist/
├── flatpak-build/                     ← flatpak-builder working tree (gitignored)
├── flatpak-repo/                      ← OSTree repo (gitignored, published to koher.app)
├── sensorium-0.1.0.flatpak      ← single-file bundle (gitignored, attached to GitHub release)
└── sensorium.flatpakref         ← pointer file (gitignored, hosted at koher.app/sensorium/install)
```

---

## Prerequisites (Ubuntu 24.04 LTS)

```bash
# Build toolchain
sudo apt install build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev \
                 libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
                 libayatana-appindicator3-dev librsvg2-dev libglib2.0-dev libgtk-3-dev

# Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Flatpak runtime + builder
sudo apt install flatpak flatpak-builder
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub org.gnome.Platform//46 org.gnome.Sdk//46
```

PATH note: this machine has `~/.local/bin/cc` (Claude Code launcher) shadowing `/usr/bin/cc`. Every cargo/Tauri build command needs `PATH="/usr/bin:$PATH"` prepended. See top-level `BUILD-STATUS.md` for the full context.

---

## Build sequence

From the `sensorium/` directory:

```bash
# 1. Produce the .deb (cold compile ~4 min; incremental ~30 s)
#    Output: src-tauri/target/release/bundle/deb/sensorium_0.1.0_amd64.deb
#    The launcher will display "Sensorium" — see the custom .desktop
#    template at linux/sensorium.desktop, referenced from tauri.conf.json.
PATH="/usr/bin:$PATH" npx tauri build --bundles deb

# 2. Wrap the .deb in a flatpak
bash scripts/build-flatpak.sh
```

### Naming convention

Filenames everywhere use the canonical `sensorium` form (single token, lowercase):

- `sensorium_0.1.0_amd64.deb`
- `sensorium-0.1.0.flatpak`
- `sensorium.flatpakref`
- `/usr/bin/sensorium` (binary, after install)
- `sensorium.desktop` (the application launcher file)

Display names use "Sensorium":

- The window title bar
- GNOME Activities / launcher
- The flatpak app catalog (via AppStream metainfo)

The split is enforced by `productName: "sensorium"` + `mainBinaryName: "sensorium"` (drives filenames) plus the custom `.desktop` template at `linux/sensorium.desktop` (forces `Name=Sensorium` in the launcher).

The flatpak bundle identifier stays namespaced: `app.koher.sensorium`. This is reverse-DNS — "sensorium app from koher" — and is the stable identifier flatpak uses to resolve the app, irrespective of the binary name. Same convention for the GitHub repo: `koherarchitecture/sensorium`.

---

## Local install / smoke test

```bash
# .deb path
sudo apt install ./src-tauri/target/release/bundle/deb/sensorium_0.1.0_amd64.deb
sensorium                                # launch
sudo apt remove sensorium                # uninstall

# .flatpak path
flatpak install --user --bundle dist/sensorium-0.1.0.flatpak
flatpak run app.koher.sensorium                # launch
flatpak uninstall --user app.koher.sensorium   # uninstall
```

The flatpak's user-data lives at `~/.var/app/app.koher.sensorium/config/koher/sensorium/` (sandboxed); the `.deb` install uses `~/.config/koher/sensorium/` (XDG conventions, host filesystem). Both paths are documented in spec §12.

---

## Distribution

The `.deb`, `.flatpak`, and `.flatpakref` are attached to the GitHub release on `koherarchitecture/sensorium`. The `.flatpakref` and the OSTree repo are also hosted at `koher.app/sensorium/install` and `koher.app/sensorium/flatpak/` respectively, so users can install with one click via:

```
flatpak install --user https://koher.app/sensorium/install/sensorium.flatpakref
```

This is a self-hosted channel, **not Flathub**. See spec §13.2.2 for the rationale.
