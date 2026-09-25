# Upstream / solutions PRs — prepared submissions

PRs prepared for upstream (`logos-blockchain/logos-execution-zone`) and
the Logos solutions catalog. PRs 1–3 are filed:

- **PR 1** → https://github.com/logos-blockchain/logos-execution-zone/pull/922
- **PR 2** → https://github.com/logos-blockchain/logos-execution-zone/pull/923
- **PR 3** → https://github.com/logos-blockchain/lez-programs/pull/396
  (filed to `lez-programs` — no upstream LPs/specs repo exists)
- **PR 4** → unblocked — `.lgx` + `index.json` now publish on release;
  what remains is the catalog-listing PR against `logos-co/logos-modules-v2`
  (their merge is the external gate).
- **PR 5** → https://github.com/logos-blockchain/logos-blockchain-circuits/pull/57
  (macOS x86_64 + Android/iOS build legs, ptau + gmp fixes)
- **PR 6** → https://github.com/logos-blockchain/logos-blockchain-rust-rapidsnark/pull/2
  (Windows static archive + target mapping; flags the missing LICENSE)
- **PR 7** → https://github.com/logos-blockchain/logos-execution-zone/pull/924
  (`keycard` cargo feature — unblocks Android/iOS wallet-core builds)

**Platform status** (fork releases are live regardless of upstream merge):
`TerexitariusStomp/logos-blockchain-circuits` `v0.5.3` publishes 7 bundles —
linux x86_64/aarch64, macOS aarch64/x86_64, windows x86_64, **android aarch64,
ios aarch64**. `TerexitariusStomp/logos-blockchain-rust-rapidsnark`
`rapidsnark-pic-v0.0.8` adds the Windows PIC archive. `wsp-lez-core` compiles
for `aarch64-linux-android`/`aarch64-apple-ios` via `--no-default-features`
(keycard gate, verified by `.github/workflows/probe-mobile.yml`).

Each entry below is self-contained: title, motivation, and the exact
diff/content.

## PR 1 — `wsp-lez`/`lee` wallet: `LEZ_SEQUENCER_URL` env override

**Repo**: logos-execution-zone · **Files**: `lez/wallet/src/config.rs`

**Motivation**: upstream wallet reads the sequencer URL only from its
config file. Integration tests and CI must write a config to point at a
standalone sequencer — brittle when the wallet's config layout changes.
A one-line env override makes the standalone-sequencer e2e a drop-in
(same pattern as `INDEXER_RPC_URL` on the indexer service).

**Change** (as implemented downstream in
`crates/wsp-lez-core/src/worker.rs` via `config_overrides`):

```rust
if let Ok(url) = std::env::var("LEZ_SEQUENCER_URL") {
    config.sequencer_url = url;
}
```

**Downstream proof**: `.github/workflows/ci.yml` `e2e` job — standalone
sequencer (`--features standalone,testnet`) + wallet init/faucet/transfer
entirely env-driven.

## PR 2 — docs: standalone-sequencer e2e recipe

**Repo**: logos-execution-zone · **Files**: `docs/` (new page) or the
`standalone` feature docs

**Motivation**: the `standalone` + `testnet` features give a
self-contained chain with the pinata genesis — ideal for integration
tests — but the recipe (build with libclang for `librocksdb-sys`
bindgen, `block_create_timeout` ≈ 15 s so balance assertions must poll,
config notices on stdout before JSON output) is tribal knowledge.

**Change**: a docs page capturing exactly the workflow in this repo's
`.github/workflows/ci.yml` e2e job — usable verbatim by other builders.

## PR 3 — LP-0023: `register_self` chained-call authorization pattern

**Repo**: logos-execution-zone (or the LPs repo) · **Files**:
LP-0023 reference implementation / spec appendix

**Motivation**: the registry spec needs a deployer-auth model, and
`#[account(signer)]` cannot express "the program did this" — deployment
is unsigned and a program id has no keypair. The `caller_program_id`
chained-call pattern is the only on-chain proof available:

```
user tx → program.register_self ──chained call──▶ registry.register_deployer
                                                 (caller == program → accept)
```

**Change**: document the pattern + the three SPEL gotchas we hit
implementing it (`#[account(init)]` auto-generates claims so foreign
entry PDAs must be plain mentions; `post_states.len() ==
pre_states.len()` requires passing declared accounts through unchanged;
`caller_program_id` is `[0;8]`/all-zeros for top-level calls). Reference:
`programs/{registry,testimonial,pointer}` + live testnet verification in
`programs/ARTIFACTS.md`.

## PR 4 — solutions catalog: widespread-wallet module pair

**Repo**: Logos solutions/catalog repo · **Content**: the entry is
already written — `logos-repo.json` (schemaVersion 1) + module metadata
+ release workflows under `catalog/`. The PR adds the repo to the
catalog index once the first `index.json` release asset exists.

**Blockers**: first `release-on-merge` run must publish `.lgx` builds +
regenerate `index.json`; module `flake.nix` `cargoDeps` hash needs the
first nix build to resolve (fakeHash documented inline).
