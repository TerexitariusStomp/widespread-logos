# @widespread/lez-wasm

Vendored build artifact of `crates/wsp-lez-wasm` — a wasm32 facade over the
upstream `lee_core` (v0.2.4) and `spel-framework-core` codecs. No authored
crypto: account-id codecs, public/private PDA derivation, view tags, ML-KEM-768
decapsulation, and private note decrypt — exactly the functions the wallet
uses for viewing.

## Rebuild

```bash
cargo build -p wsp-lez-wasm --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/wsp_lez_wasm.wasm \
  --out-dir packages/lez-wasm --target web
```

Commit the regenerated `wsp_lez_wasm.*` together with any `lib.rs` change —
the artifact is intentionally vendored so browser surfaces never need a Rust
toolchain.

## Hosts

- Extension: copy into `src/lib/lez-wasm/` + `public/lez/` (cross-repo vendor).
- PWA / web surfaces: `import init, * as codecs from '@widespread/lez-wasm'`
  then `init(url_of_wasm)` — pass a URL for the `.wasm` binary.
