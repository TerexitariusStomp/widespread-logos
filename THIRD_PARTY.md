# Third-Party OSS Inventory

Every upstream repository this project builds on, fetches, vendors, or
references. All entries have commercially usable licenses; repositories
without an acceptable license are reference-only and are never vendored or
linked.

## Direct dependencies

| Repository | Pin | License | Role | Consumed as |
|---|---|---|---|---|
| [logos-blockchain/logos-execution-zone](https://github.com/logos-blockchain/logos-execution-zone) | `0e4691d395fb0ebbe38f611fe2b7bc47446edb70` (wallet deps); tag `v0.2.4` (guest programs, matching `spel-framework`'s `nssa_core` pin) | MIT | LEZ wallet engine (`wallet`), program/account types (`lee`, `lee_core`), SPEL `InstructionData`, standalone sequencer | Cargo git dep (`wallet`, `lee`, `lee_core`) |
| [logos-co/logos-rust-sdk](https://github.com/logos-co/logos-rust-sdk) | `bcc36420d7a15fb39cbf8079c85a18650cdae968` (v0.3.0) | MIT OR Apache-2.0 | Logos Core module SDK — vendored at `third_party/logos-rust-sdk`; provides `logos_sdk` crate + `logos-lidl-gen` | Vendored source + Cargo dep |
| [logos-co/spel](https://github.com/logos-co/spel) | `6c0598a409ab801df843d99a46c04a13105df663` | MIT OR Apache-2.0 | SPEL program framework — `#[lez_program]`/`#[instruction]` macros, `SpelOutput`, `SpelError` | Cargo git dep (programs/*) |
| [logos-co/logos-lidl-gen](https://github.com/logos-co/logos-lidl-gen) | built from logos-rust-sdk tree | Apache-2.0 | IDL compiler — generates `provider_gen.rs` from `*.lidl` | Build tool |
| [logos-co/logos-lidl](https://github.com/logos-co/logos-lidl) | built from source | Apache-2.0 | LIDL runtime libraries required by `logos-lidl-gen` | Build-time static libs |
| [logos-co/logos-webview-app](https://github.com/logos-co/logos-webview-app) | `b5d1bb40da6ba550076069a10cf9beaac45aa515` | MIT OR Apache-2.0 | Reference + pattern for `widespread_wallet_ui` (WebView drain-pump bridge) | Vendored reference; pattern reused |
| [logos-blockchain/logos-execution-zone-module](https://github.com/logos-blockchain/logos-execution-zone-module) | `825d2a41262b9882aa0f9ca837cb03635f7980c2` | MIT OR Apache-2.0 | Upstream LEZ module — reference for metadata/codegen conventions | Vendored reference |
| [logos-co/lez-faucet](https://github.com/logos-co/lez-faucet) | `8a20144c70c5acbab15526f8470a878500fe55c6` | MIT OR Apache-2.0 | Testnet token faucet module — adoption funnel step 1 | Module dependency (future wrapper) |
| [logos-messaging/logos-delivery-js](https://github.com/logos-messaging/logos-delivery-js) | `0ca94f3c8beda0fba2962c3daae17b3ec689ae49` | MIT OR Apache-2.0 | Decentralized delivery — device pairing + private messaging transport | npm dep (planned) |

## Transitive dependencies pinned by Cargo.lock

| Repository | Pin | License | Role |
|---|---|---|---|
| [logos-blockchain/logos-blockchain](https://github.com/logos-blockchain/logos-blockchain) | `f6533aaa9895b7b74d37685312805c56e0adc2d8` | MIT | Consensus/circuit types pulled by `wallet` |
| [logos-blockchain/logos-blockchain-circuits](https://github.com/logos-blockchain/logos-blockchain-circuits) | tag `v0.5.7` | MIT | Proving circuits |
| [logos-blockchain/logos-blockchain-rust-rapidsnark](https://github.com/logos-blockchain/logos-blockchain-rust-rapidsnark) | `e91187f8ccb5bbfc7bb00dac88169112428da78f` | MIT | Rapidsnark FFI |
| [keycard-tech/keycard-rs](https://github.com/keycard-tech/keycard-rs) | `9535a657ba04b1e6916de51777e22b4837c1a84d` | MIT OR Apache-2.0 | Hardware-wallet (Keycard) support in `wallet`; pulls `pcsc-sys` |
| [EspressoSystems/jellyfish](https://github.com/EspressoSystems/jellyfish) | `8d80230358e900f8d63765a937f63f4978ca1daa` + tag `jf-crhf-v0.2.0` | MIT | Zero-knowledge primitives |
| [arkworks-rs/spongefish](https://github.com/arkworks-rs/spongefish) | `3ded547f7f56d7f8a1fc4c9a5c0ce965310bba5f` | MIT OR Apache-2.0 | Fiat-Shamir transcript library |
| [logos-co/Overwatch](https://github.com/logos-co/Overwatch) | `ae887f41f5a626c341179026ad7f03953ff2072e` | MIT | Service framework used by upstream wallet |

All other transitive crates resolve from crates.io and are recorded in
`Cargo.lock` with checksums.

## System / native requirements

| Component | Source | License | Needed by |
|---|---|---|---|
| `libpcsclite` | PC/SC Lite (pcsc-lite) | BSD-3-Clause | `keycard-rs` → `pcsc-sys` (build-time + runtime for Keycard support) |
| Qt 6 (`qtdeclarative`, `qtwebview`) | Qt Project | LGPL-3.0 | Runtime for `widespread_wallet_ui` QML host — dynamically linked, not vendored |
| RISC Zero toolchain | risc0 | Apache-2.0 | SPEL guest program compilation |

## npm / TypeScript dependencies

| Package | License | Role |
|---|---|---|
| `react`, `react-dom` | MIT | wallet-ui rendering |
| `esbuild` | MIT | web bundle build tool |
| `typescript` | Apache-2.0 | typecheck/build |
| [`privy-io/shamir-secret-sharing`](https://github.com/privy-io/shamir-secret-sharing) `0.0.4` | Apache-2.0 | 2-of-3 share split/combine (recovery package) |
| `@noble/hashes`, `@noble/ciphers`, `@noble/curves` `2.4.0` | MIT | AES-GCM/HKDF building blocks (wallet-extension deps, Rooted repo) |
| `qrcode-generator` `1.5.0` | MIT | Recovery-kit QR export (wallet-extension dep, Rooted repo) |
| `@simplewebauthn/browser` | MIT | Passkey ceremony helper (planned; `navigator.credentials` used directly today) |
| `eth-phishing-detect` | MIT | Approval-guard blocklist (planned, extension side) |
| `logos-delivery-js` | MIT OR Apache-2.0 | Pairing/messaging transport (planned) |
| `logos-storage-js` | Apache-2.0 | Browser-side Logos Storage uploads for vault backup |
| [`logos-storage/logos-storage-go-bindings`](https://github.com/logos-storage/logos-storage-go-bindings) | Apache-2.0 | Native worker → Logos Storage blob persistence (planned) |
| [`logos-storage/logos-storage-go`](https://github.com/logos-storage/logos-storage-go) | MIT OR Apache-2.0 | Storage node REST client under the Go bindings (planned) |

## Reference-only (never vendored or linked)

| Repository | License status | Use |
|---|---|---|
| `solana-program/program-metadata` | check before use | LP-0023 cited prior art — design reference only |
| `solana-foundation/idl-spec` | check before use | IDL format reference for registry program |
| `logos-modules-release-base` / `-action` | none declared | Spec-mandated fork mechanism for catalog submission — fork at submission time, no code imported |

## Compliance notes

- Submitted code is dual-licensed **MIT OR Apache-2.0** (`LICENSE-MIT`,
  `LICENSE-APACHE` at repo root).
- Qt WebView/QML runtime is **LGPL-3.0** and is consumed only as a
  dynamically linked system/runtime dependency via nix — never vendored,
  never statically linked — consistent with LGPL obligations.
- All cargo git deps are pinned to exact commit SHAs in `Cargo.toml` and
  `Cargo.lock`; npm deps are locked by `package-lock.json`.
