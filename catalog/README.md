# Catalog release structure

How `widespread_wallet` + `widespread_wallet_ui` reach the Basecamp module
catalog — the same `logos-modules-release-action` pipeline `lez-faucet`
ships with.

## Pieces

| File | Role |
|---|---|
| `../logos-repo.json` | Catalog repo manifest — `schemaVersion: 1`, `indexUrl` (the published catalog index), `trustedSigners` (empty: no third-party signer set yet) |
| `../.github/workflows/release-widespread-wallet.yml` | Manual-dispatch release of the core module — calls the shared `release.yml` with `module_path: modules/widespread_wallet` |
| `../.github/workflows/release-widespread-wallet-ui.yml` | Same for the QML UI module |
| `../.github/workflows/release-on-merge.yml` | Publishes both once `main` is green and the version is unpublished; refuses version skew between the pair |
| `../.github/workflows/rebuild-index.yml` | Rebuilds the catalog `index.json` release asset from published `.lgx` URLs |

## Flow

```
metadata.json version bump → CI green on main → release-on-merge gate
  → release.yml per module → nix build #lgx-portable (3 runners)
  → .lgx + sidecar.json uploaded to tag release
  → rebuild-index regenerates index.json → lgpd install resolves it
```

Install (once published):

```bash
lgpd install https://github.com/TerexitariusStomp/widespread-logos/releases/download/index/index.json
```

## Prerequisites for a green release

- `modules/widespread_wallet/flake.nix` and
  `modules/widespread_wallet_ui/flake.nix` exposing `#lgx-portable` for
  `darwin-arm64`, `linux-amd64`, `linux-arm64` — the release variants the
  shared workflow defaults to. The core module links the LEZ client stack
  (rapidsnark + logos-blockchain-circuits per-platform archives); the
  `third_party/lez-faucet/faucet-module/flake.nix` comments document the
  exact RAPIDSNARK_LIB_DIR / LBC_ROOT_DIR plumbing to mirror.
- A `CI` workflow (release-on-merge triggers on it).
- Both `metadata.json` versions equal — the gate refuses a skewed pair.
