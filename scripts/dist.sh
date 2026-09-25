#!/usr/bin/env bash
# Produce the consumer-facing artifact tree for this repo's released outputs.
#
#   scripts/dist.sh [--version X.Y.Z] [--skip-cargo] [--skip-npm]
#
# Output layout (also the GitHub-release layout — Rooted's fetch script
# consumes either a release base URL or this directory via file://):
#
#   dist/
#     manifest.json          version + artifact list with sha256 + kind
#     SHA256SUMS.txt         sha256 over every artifact
#     npm/                   `npm pack` tarballs of the publishable packages
#     bin/wsp-lezd-<target>  native-messaging daemon per target triple
#     bin/wsp-lez-<target>   CLI per target triple
#     install-host.sh        host-manifest installer (works on a downloaded dist)
#
# The build host's target triple is used for binaries; CI runs this per
# matrix leg and merges the per-leg dist/ trees before release upload.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
VERSION="${WSP_DIST_VERSION:-0.1.0}"
SKIP_CARGO=0
SKIP_NPM=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --skip-cargo) SKIP_CARGO=1; shift ;;
    --skip-npm) SKIP_NPM=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$DIST/npm" "$DIST/bin"

target_triple() {
  rustc -vV | sed -n 's/^host: //p'
}

TRIPLE="$(target_triple)"

# ── Rust binaries ────────────────────────────────────────────────────────
if [[ $SKIP_CARGO -eq 0 ]]; then
  cargo build --release -p wsp-lezd -p wsp-lez
  for bin in wsp-lezd wsp-lez; do
    cp "target/release/$bin" "$DIST/bin/$bin-$TRIPLE"
  done
fi

# ── npm tarballs ─────────────────────────────────────────────────────────
if [[ $SKIP_NPM -eq 0 ]]; then
  for pkg in packages/lez-wasm packages/recovery packages/storage-client \
             packages/wallet-ui sdk/provider sdk/registry; do
    (cd "$ROOT/$pkg" && npm pack --pack-destination "$DIST/npm" >/dev/null)
  done
fi

cp "$ROOT/scripts/install-host.sh" "$DIST/install-host.sh"
chmod +x "$DIST/install-host.sh"

# ── Checksums + manifest ─────────────────────────────────────────────────
cd "$DIST"
( cd "$DIST" && find npm bin -type f | sort | xargs sha256sum && sha256sum install-host.sh ) > SHA256SUMS.txt

python3 - "$VERSION" <<'PY'
import hashlib, json, os, sys
version = sys.argv[1]
arts = []
for root, _, files in os.walk('.'):
    for f in sorted(files):
        if f in ('manifest.json', 'SHA256SUMS.txt'):
            continue
        path = os.path.join(root, f)
        kind = 'npm' if f.endswith('.tgz') else ('bin' if '/bin/' in path else 'misc')
        arts.append({
            'file': path.lstrip('./'),
            'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(),
            'kind': kind,
        })
json.dump({'version': version, 'artifacts': arts},
          open('manifest.json', 'w'), indent=2)
PY

echo "dist ready: $DIST (version $VERSION, target $TRIPLE)"
ls -R "$DIST" | head -30
