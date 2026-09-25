# widespread-registry — LP-0023 program registry

On-chain SPEL program implementing the LP-0023 program registry on the
LEZ testnet. See `../ARTIFACTS.md` for image ids, deployment records, and
the live entry PDAs.

## On-chain vs off-chain split

**On-chain** (bounded, `RegistryEntry` at two PDA namespaces):

| Field | Bound | Note |
|---|---|---|
| `program_id` `[u8;32]` | fixed | program-id bytes (image id) |
| `author` `[u8;32]` | fixed | deployer: program's own bytes; third-party: signer |
| `kind` `u8` | fixed | 0=deployer, 1=third_party |
| `name` | 1–64 | validated in guest |
| `version` | 1–32 | |
| `description` | ≤512 | |
| `commit` | 1–64 | reproducibility metadata |
| `tags`, `repo_url`, `build_config` | unbounded* | *bounded indirectly by the account data cap |
| `idl_cid`, `source_cid` | required | Logos Storage CIDs — **pointers, not content** |
| `registered_at` `u64` | fixed | caller-supplied unix time |

**Off-chain** (unbounded content, content-addressed on Logos Storage):
the IDL document itself and the built ELF/source snapshots. `idl_cid` and
`source_cid` are the only on-chain references to them — entries stay
small enough for account data caps while the heavy artifacts remain
retrievable by CID from any storage node. If a git host or the upstream
repo disappears, the CIDs still resolve (the "deleted repo" case).

## Deployer-entry authorization

Deployment is unsigned and a program id is not a key-bearing account, so
`#[account(signer)]` cannot prove "the program did this". The registry
instead requires `caller_program_id == program` — the state machine sets
`caller_program_id` to the calling program (`[0;8]` for top-level user
transactions), so a deployer entry can only be written by a chained call
**from the program itself**:

```
user tx → program.register_self ──chained call──▶ registry.register_deployer
                                                 (caller == program → accept)
user tx → registry.register_deployer  (caller = 0 → REJECT: unauthorized)
```

Programs opt in by exposing `register_self`/`update_self` hooks (all
three Widespread programs do). Programs without a hook can still receive
third-party entries. Verified live: direct `register_deployer` naming the
superseded testimonial id was rejected on-chain (see ARTIFACTS.md).

## Third-party entries and the trusted-signer overlay

`register_third_party` requires only `author`'s signature — anyone may
attest anything about any program. Trust in an attestation is therefore a
**client-side** decision:

- `sdk/registry` exposes `endorse(entry, overlay)` and
  `TrustedSignerOverlay { signers: AccountId[] }` — a plain, inspectable
  list of author account ids.
- `DEFAULT_TRUSTED_SIGNERS` is empty; each deployment configures its own
  signer set. Nothing in the read path hard-codes trust.
- Consumers display `trusted` as a badge, never as a filter that hides
  the underlying entry — the overlay annotates, it does not censor.

## IDL fetch and graceful degradation

`RegistryClient.fetchIdl(entry, nodeUrl)` streams the IDL by `idl_cid`
from a Codex node (`/api/storage/v1`, with `/api/codex/v1` fallback for
older nodes). A dead node, missing CID, or malformed JSON returns
`{ ok: false, error }` — call-effect decoding falls back to the raw
instruction hex rather than failing, so a broken mirror never blocks a
call.
