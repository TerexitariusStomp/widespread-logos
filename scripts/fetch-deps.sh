#!/usr/bin/env bash
# Clone the upstream repositories this project references into third_party/.
# Not required to build — all Cargo deps resolve from git pins — but needed to:
#   * build `logos-lidl-gen` (regenerate modules/widespread_wallet provider_gen.rs)
#   * build the `spel` CLI (source-scan IDL generation, `spel init` scaffolds)
#   * read upstream reference sources (webview-app, lez-faucet, delivery-js)
#
# Pins match THIRD_PARTY.md exactly.
set -euo pipefail
cd "$(dirname "$0")/.."

clone_at() {
  local url="$1" sha="$2" dir="third_party/$(basename "$url" .git)"
  if [ -d "$dir/.git" ]; then
    echo "== $dir already present; verifying pin"
  else
    git clone "$url" "$dir"
  fi
  git -C "$dir" fetch --quiet origin "$sha" 2>/dev/null || true
  git -C "$dir" checkout --quiet "$sha"
  echo "   $(basename "$dir") @ ${sha:0:12}"
}

clone_at https://github.com/logos-co/logos-rust-sdk              bcc36420d7a15fb39cbf8079c85a18650cdae968
clone_at https://github.com/logos-co/spel                        6c0598a409ab801df843d99a46c04a13105df663
clone_at https://github.com/logos-co/logos-webview-app           b5d1bb40da6ba550076069a10cf9beaac45aa515
clone_at https://github.com/logos-blockchain/logos-execution-zone-module 825d2a41262b9882aa0f9ca837cb03635f7980c2
clone_at https://github.com/logos-co/lez-faucet                  8a20144c70c5acbab15526f8470a878500fe55c6
clone_at https://github.com/logos-messaging/logos-delivery-js    0ca94f3c8beda0fba2962c3daae17b3ec689ae49
clone_at https://github.com/logos-blockchain/logos-execution-zone 0e4691d395fb0ebbe38f611fe2b7bc47446edb70

echo "done — all reference checkouts pinned per THIRD_PARTY.md"
