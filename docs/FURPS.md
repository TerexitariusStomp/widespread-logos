# FURPS self-assessment

Honest self-assessment of the Widespread LEZ wallet against the FURPS
quality model. Each claim links to the code or doc that backs it; gaps
are stated as gaps.

## Functionality

- **Wallet core** (`crates/wsp-lez-core`): vault init/restore, account
  derivation (public + private), balances, sync, transfers, program
  calls, faucet, registry lookup, account read, viewing-key export,
  blob import/export — all behind the single `execute(op, blob)`
  contract shared by every surface. Verified end-to-end on testnet 0.3
  and against a standalone sequencer (init → faucet claim → transfer →
  balance poll; `docs/` CI workflow `e2e` leg).
- **Surfaces**: CLI (`wsp-lez`), Chromium native-messaging daemon
  (`wsp-lezd`), browser extension, Logos Core module
  (`modules/widespread_wallet`), Tauri sidecar, PWA (read/recovery,
  signing honestly rejected via `UnsupportedSurfaceError`).
- **LP-0023 registry**: three programs deployed and self-registered on
  testnet via the `caller_program_id` chained-call proof; unauthorized
  deployer registration demonstrated rejected on-chain; third-party
  entries live (`programs/ARTIFACTS.md`, `programs/registry/README.md`).
- **Recovery** (`packages/recovery`): passkey-PRF + kit + paired-device
  factors, client-side-encrypted Logos Storage persistence, on-chain
  pointer lookup. Full e2e verified on a live node including negative
  cases (wrong passphrase rejected, single-factor insufficient).
- **dApp SDK** (`sdk/provider`): connect/transfer/program-call/events;
  per-transaction approval gate with IDL-decoded effects
  (`packages/wallet-ui/src/approval.ts`).

## Usability

- One shared React UI (`packages/wallet-ui`) across extension, module,
  PWA, and Tauri — no surface-specific wallet logic.
- Social sign-in onboarding (OAuth → passkey PRF → vault → kit export)
  keeps key custody client-side; OAuth tokens never touch key material.
- Approval sheets show decoded call effects; unknown programs fall back
  to raw hex with a warning rather than blocking.
- **Gap**: the PWA cannot sign — users hitting it for the first time get
  reads/recovery only. This is deliberate (no key custody in pure
  browser) but should be messaged more prominently in the UI.

## Reliability

- `cargo clippy --workspace --all-targets -- -D warnings` clean;
  `cargo test --workspace` green (worker session tests, wasm codec
  round-trip, module ping test).
- Extension: 21 leak-guard tests asserting private ops are unreachable
  from page origins; full `tsc` + `esbuild` build clean.
- Native-messaging framing is isolated from upstream stdout logging
  (dup'd fd) — no protocol corruption path.
- CI (`.github/workflows/ci.yml`): Linux + macOS Rust legs, TS
  typecheck/tests, and the standalone-sequencer e2e that was verified
  locally (stdout-noise-tolerant JSON parsing, block-inclusion polling).
- **Gap**: Tauri leg compiles only where dbus/webkit system deps exist;
  the CI matrix covers it via the module/nix path rather than raw
  `cargo check`.

## Performance

- Per-instruction Risc0 cycle counts measured for all three programs
  (`docs/benchmarks/cycle_bench.md`): 96K–206K user cycles, all single
  segment — comparable to upstream's cheapest built-ins and far below
  the public-execution cycle cap.
- Private-output scanning filters by view tag before any decapsulation
  (ML-KEM only runs on candidate outputs) — `wsp-lez-wasm` is a thin
  facade over upstream `lee_core` codecs, no authored crypto.
- Blob persistence is one ciphertext upload/download; storage calls are
  off the signing path entirely.

## Supportability

- Licensing: `LICENSE-APACHE` + `LICENSE-MIT`; vendored/upstream code
  inventoried in `THIRD_PARTY.md`.
- Docs: per-package READMEs (SDK provider/registry, storage, recovery,
  wallet-ui), `programs/ARTIFACTS.md` (deployment record + rebuild),
  `docs/benchmarks/cycle_bench.md`, `catalog/README.md`.
- Reproducibility: programs build via pinned docker risc0 toolchain
  (`make build` per program); image ids recorded; artifacts mirrored to
  Logos Storage so a deleted git host doesn't break verification.
- Packaging: nix flakes for both Logos modules (`flake.nix`,
  `mkLogosModule` external-lib pattern matching the proven faucet
  module), release workflows for catalog variants.
- **Gap**: nix `cargoDeps` hash is a fakeHash placeholder pending the
  first nix build (documented in the flake); solutions PRs upstream are
  not yet opened.
