# widespread-logos

Widespread's Logos stack: a real [Logos Execution Zone](https://github.com/logos-blockchain/logos-execution-zone) (LEZ) wallet — provider SDK, browser-extension adapter, native-messaging daemon, CLI, Logos Core module — plus the LP-0023 program registry, a testimonial program, and a decentralized pointer program for client-side recovery.

**Custody model:** keys, vault state, and shares never leave the client except as client-side-encrypted ciphertext on Logos Storage. There is no gateway, no custodian, and no server-held recovery material — if every recovery factor (passkey, recovery kit, paired device) is lost, the wallet is unrecoverable by design.

## Layout

```
crates/
  wsp-lez-core   Stateless worker: execute(op, blob) -> (result, blob') over upstream WalletCore
  wsp-lezd       Chromium native-messaging daemon wrapping the worker
  wsp-lez        CLI over the worker (vault.blob persistence)
modules/
  widespread_wallet      Logos Core module (LIDL contract + generated provider + worker host)
  widespread_wallet_ui   QtWebView UI module hosting the shared wallet-ui bundle
programs/
  testimonial    SPEL program — on-chain testimonials carrying a submission identifier (LP-0021)
  registry       SPEL program — LP-0023 program registry (deployer vs third-party entries)
  pointer        SPEL program — key/value ptr→CID resolution for recovery-share lookup
packages/
  wallet-ui      Shared React UI over pluggable WalletBackends (module bridge /
                 extension messages / Tauri sidecar / direct-RPC PWA)
  lez-wasm       Vendored wasm32 build of wsp-lez-wasm — upstream LEZ codecs
                 (account ids, PDAs, ML-KEM-768 viewing decrypt) for browsers
apps/
  wallet-tauri   Desktop shell hosting wallet-ui; wsp-lezd sidecar for signing
  recovery       Shamir shares + passkey-PRF derivation + sealed recovery kit + Storage client
sdk/
  provider       @widespread/lez-provider — dApp-facing connect/approve/transact SDK
web/
  wallet         esbuild bundle → modules/widespread_wallet_ui Resources.js;
                 also builds the installable PWA shell (manifest + service
                 worker; falls back to PwaBackend off-extension)
third_party/     Pinned upstream reference checkouts — populated by
                 scripts/fetch-deps.sh (see THIRD_PARTY.md)
scripts/         install-host.sh, build-ui.sh
```

## Build

```bash
# Rust workspace (worker, daemon, CLI, Logos module)
PKG_CONFIG_PATH="$HOME/.local/share/wsp-pcsc/lib/pkgconfig:$PKG_CONFIG_PATH" \
  cargo build --workspace
cargo test --workspace

# Shared wallet UI bundle + QML resources
npm install
scripts/build-ui.sh
```

`libpcsclite` is required by the upstream wallet's Keycard support
(`pcsc-sys`). On machines without it installed, extract the distro dev
package into `~/.local/share/wsp-pcsc` and set `PKG_CONFIG_PATH` as above.

## Transports — one worker contract everywhere

```text
execute(op, blob) -> (result, blob')
```

- **CLI** keeps the blob at `~/.wsp-lez/vault.blob`.
- **`wsp-lezd`** speaks Chromium native messaging (4-byte LE length + JSON)
  on behalf of the extension; it keeps no durable state and drops the
  session on stdin close. Ordinary stdout is redirected away from the
  protocol stream so upstream logging can't corrupt framing.
- **`widespread_wallet`** module exposes `execute/connect/get_accounts/
  get_balance/propose_transaction/get_status` via LIDL and hosts the same
  worker inside Logos Core.
- **Extension** (`apps/wallet-extension` in Rooted) stores the LEZ blob
  inside its existing sealed vault (`vault.lez`) and talks to `wsp-lezd`
  over native messaging.
- **Desktop** (`apps/wallet-tauri`) hosts the same bundle and drives
  `wsp-lezd` as a Tauri sidecar — identical wire protocol, vault blob under
  the OS app-data dir.
- **PWA / plain web** (`web/wallet/dist`) is a view + recovery surface:
  balances/account reads go straight to the sequencer, private viewing runs
  in the vendored wasm codecs against viewing keys extracted from an
  imported vault blob, and recovery (passkey/kit → Logos Storage → blob)
  works end-to-end. Signing ops throw `UnsupportedSurfaceError` — key
  custody stays on signing surfaces.

## Platform support

The proving chain links per-platform prebuilt archives (circuits +
rapidsnark). Surfaces that sign or prove need one; view/recover surfaces
(PWA) don't and run anywhere a modern browser runs.

| Platform | Module `.lgx` | CLI / daemon / Tauri | PWA (view + recovery) |
|---|---|---|---|
| Linux x86_64 | ✅ release variant | ✅ | ✅ |
| Linux arm64 | ✅ release variant | ✅ | ✅ |
| macOS Apple Silicon | ✅ release variant | ✅ | ✅ |
| macOS Intel | source build (`x86_64-darwin` flake entry) | ✅ (via fork archive) | ✅ |
| Windows x86_64 | ✅ release variant (mingw cross) | ✅ | ✅ |
| Android / iOS | circuits bundles build on the fork CI (aarch64); `wsp-lez-core` compiles for `aarch64-linux-android` / `aarch64-apple-ios` with `--no-default-features` (keycard/PCSC off — upstream PR logos-execution-zone#924). `.github/workflows/probe-mobile.yml` is the gate | — | ✅ |

Forks supplying the extra archives: `TerexitariusStomp/logos-blockchain-circuits`
(macos-x86_64, windows, android, ios legs) and
`TerexitariusStomp/logos-blockchain-rust-rapidsnark` (windows-pic archive).
Both are CI-only deltas pending upstream merge.

## Ops

`Ping Init Restore Unlock Lock ExportBlob CreateAccount ListAccounts
Balance Sync Status Programs Transfer ProgramCall`

Accounts use upstream string forms `Public/<base58>` / `Private/<base58>`.
Amounts are decimal strings on the wire (`u128`-safe).

Session-init ops (`Init`/`Restore`/`Unlock`) take an optional `zone`
selector — the LP-0022 forward-design seam. `lez` (default) is the public
testnet; a sequencer URL selects a custom zone (standalone sequencer,
devnets); unknown selectors are rejected at session init. `Status`
reports the session's zone. See `crates/wsp-lez-core/src/zone.rs`.

## SPEL programs

All three follow the real `spel init` layout (`methods/guest`, RISC Zero
guest bins, `examples/generate_idl.rs`) with deps pinned to exact upstream
revisions. `programs/registry` implements the LP-0023 data model:
deployer entries are authorized by `caller_program_id` — only a chained
call *from* the program itself (via its `register_self` hook) can write
them; third-party entries are open to any signer, who is recorded as
`author`. See `programs/registry/README.md` for the full authorization
model.

Built ELFs, image IDs, and generated IDLs are catalogued in
`programs/ARTIFACTS.md`.

## Prize targets

- **LP-0021** LEZ Wallet & Provider SDK — module + SDK + UI
- **LP-0023** LEZ Program Registry — `programs/registry` + tooling
- **LP-0022** Combined Blockchain and Zone Wallet — forward design
  (`zone.rs` + `zone` on session-init ops + `ZONE_INDEXERS` in the SDK)

## Docs

| Doc | Contents |
|---|---|
| `docs/FURPS.md` | FURPS self-assessment |
| `docs/benchmarks/cycle_bench.md` | Per-instruction Risc0 cycle counts for all three programs |
| `docs/solutions-prs.md` | Prepared upstream/solutions PR submissions |
| `programs/ARTIFACTS.md` | Deployed program ids, tx hashes, storage CIDs, rebuild steps |
| `programs/registry/README.md` | LP-0023 authorization model + on/off-chain split |
| `catalog/README.md` | Module catalog release structure |

See `THIRD_PARTY.md` for the complete OSS inventory and license map.

## License

Dual-licensed under MIT OR Apache-2.0.
