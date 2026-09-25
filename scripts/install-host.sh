#!/usr/bin/env bash
# Install the wsp-lezd native-messaging host for Chromium-family browsers.
#
# Two modes:
#   scripts/install-host.sh                      # use a locally-built binary
#   scripts/install-host.sh --release <base>     # download a released binary
#
# `--release <base>` accepts a GitHub release download URL or a local dist/
# directory (file:// or plain path) produced by scripts/dist.sh. The binary
# is verified against SHA256SUMS.txt before the host manifest is written.
#
# Env:
#   WSP_LEZD        explicit path to an existing binary (local mode)
#   WSP_INSTALL_DIR install prefix (default ~/.local/lib/widespread)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="fyi.widespread.lezd"
INSTALL_DIR="${WSP_INSTALL_DIR:-$HOME/.local/lib/widespread}"
RELEASE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) RELEASE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

triple() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)   echo "x86_64-unknown-linux-gnu" ;;
    Linux-aarch64)  echo "aarch64-unknown-linux-gnu" ;;
    Darwin-arm64)   echo "aarch64-apple-darwin" ;;
    Darwin-x86_64)  echo "x86_64-apple-darwin" ;;
    *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
}

fetch() { # url path
  if [[ "$1" =~ ^https?:// ]]; then
    curl -fsSL "$1" -o "$2"
  else
    cp "${1#file://}" "$2"
  fi
}

if [[ -n "$RELEASE" ]]; then
  # ── release mode: download + verify ──────────────────────────────────
  TRIPLE="$(triple)"
  mkdir -p "$INSTALL_DIR"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  fetch "$RELEASE/bin/wsp-lezd-$TRIPLE" "$TMP/wsp-lezd"
  fetch "$RELEASE/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt"
  want="$(awk -v f="bin/wsp-lezd-$TRIPLE" '$2==f {print $1}' "$TMP/SHA256SUMS.txt")"
  got="$(sha256sum "$TMP/wsp-lezd" | awk '{print $1}')"
  if [[ -z "$want" || "$want" != "$got" ]]; then
    echo "checksum mismatch for wsp-lezd-$TRIPLE (want ${want:-none}, got $got)" >&2
    exit 1
  fi
  install -m 0755 "$TMP/wsp-lezd" "$INSTALL_DIR/wsp-lezd"
  BIN="$INSTALL_DIR/wsp-lezd"
else
  # ── local mode: repo-built binary ────────────────────────────────────
  BIN="${WSP_LEZD:-$ROOT/target/release/wsp-lezd}"
  if [[ ! -x "$BIN" ]]; then
    echo "wsp-lezd not found at $BIN — build it first:" >&2
    echo "  cargo build -p wsp-lezd --release" >&2
    echo "or install a released binary:" >&2
    echo "  $0 --release <release-base-url-or-dist-dir>" >&2
    exit 1
  fi
fi

case "$(uname -s)" in
  Linux)  HOST_DIR="$HOME/.config/chromium/NativeMessagingHosts" ;;
  Darwin) HOST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts" ;;
  *)      echo "unsupported platform" >&2; exit 1 ;;
esac
mkdir -p "$HOST_DIR"

# Extension IDs allowed to talk to the host — the published Widespread
# extension ID plus dev-unpacked placeholder for local development.
EXT_IDS='[
  "chrome-extension://widespread-wallet-id/",
  "chrome-extension://dev-unpacked/"
]'

cat > "$HOST_DIR/$HOST.json" <<JSON
{
  "name": "$HOST",
  "description": "Widespread LEZ wallet worker (native messaging)",
  "path": "$BIN",
  "type": "stdio",
  "allowed_origins": $EXT_IDS
}
JSON
echo "installed $HOST -> $BIN"
echo "host manifest: $HOST_DIR/$HOST.json"
