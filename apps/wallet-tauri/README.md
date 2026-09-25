# @widespread/wallet-tauri — desktop shell

Hosts the shared `@widespread/wallet-ui` bundle (`web/wallet/dist`) in a
Tauri v2 WebView. Signing and vault operations run in the `wsp-lezd`
sidecar — the same native helper the browser extension uses — bridged by
the `lez_op` command (u32-LE-framed JSON on stdio). The sealed vault blob
is stored under the OS app-data dir via `vault_blob_get`/`vault_blob_set`.

## Surface contract

- The WebView never holds key material — `TauriBackend` ships ops to the
  helper and receives output JSON only.
- CSP restricts connections to the LEZ sequencer + Logos Storage API.
- Onboarding/recovery flows are identical to the extension surface.

## Build

```bash
# helper binary for the sidecar (workspace root)
cargo build -p wsp-lezd --release
# place it where externalBin resolves it (platform-suffixed per Tauri rules)
cp ../../target/release/wsp-lezd src-tauri/binaries/wsp-lezd-$(rustc -vV | awk '/host/ {print $2}')

npm run build   # builds web/wallet, then `cargo tauri build`
```

Requires the Tauri CLI (`cargo install tauri-cli --locked`) and the usual
platform webview toolchain. On Fedora:
`sudo dnf install webkit2gtk4.1-devel gtk3-devel dbus-devel openssl-devel
pkgconf-pkg-config` (Debian/Ubuntu equivalents: `libwebkit2gtk-4.1-dev
libgtk-3-dev libdbus-1-dev`).

## Platform note

`wsp-lezd` moves its wire stdout to a duplicated fd via `libc` — the
sidecar bridge is Unix-only today (Linux/macOS). A Windows build needs a
piped-stdout variant of `take_wire_stdout`.
