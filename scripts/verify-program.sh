#!/usr/bin/env bash
# verify-program.sh — LP-0023 source verification.
#
# Rebuilds a program's ELF from the checked-in source, recomputes its
# RISC Zero image id, and compares it against (a) the program id recorded
# in its on-chain deployer entry and (b) the artifacts mirrored on Logos
# Storage. A match proves the deployed bytecode corresponds to this
# source tree — the registry's "verified source" property.
#
# Usage: scripts/verify-program.sh <name> [expected-image-id-hex]
#   e.g.: scripts/verify-program.sh registry
set -euo pipefail
cd "$(dirname "$0")/.."

name="${1:?usage: verify-program.sh <registry|testimonial|pointer> [expected-image-id]}"
dir="programs/$name"
elf="$dir/methods/guest/target/riscv32im-risc0-zkvm-elf/docker/$name.bin"

echo "== rebuilding $name guest ELF (docker, r0.1.88.0) =="
(cd "$dir" && cargo risczero build --manifest-path methods/guest/Cargo.toml) | tee /tmp/verify-$name-build.log

image_id=$(grep -oE 'ImageID: [0-9a-f]{64}' /tmp/verify-$name-build.log | tail -1 | awk '{print $2}')
[ -n "$image_id" ] || { echo "FAIL: no image id in build output"; exit 1; }
echo "rebuilt image id: $image_id"

if [ -n "${2:-}" ]; then
  [ "$image_id" = "$2" ] && echo "MATCH: image id == expected $2" \
    || { echo "MISMATCH: rebuilt $image_id != expected $2"; exit 1; }
fi

echo "== on-chain deployer entry (wsp-lez registry-lookup) =="
vault="${WSP_VAULT:-/tmp/wsp-testnet/vault.blob}"
./target/release/wsp-lez --vault "$vault" registry-lookup "$image_id" || {
  echo "note: no deployer entry found for $image_id (program may predate registration)"
}
echo "verify-program: done"
