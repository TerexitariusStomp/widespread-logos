# @widespread/lez-registry

LP-0023 program-registry client. Reads and writes entries on the on-chain
registry program, fetches IDL artifacts from Logos Storage with graceful
degradation, and annotates third-party attestations with a trusted-signer
overlay. All reads go straight to a LEZ indexer — no centralized registry
service anywhere in the path.

Deployed program id (testnet 0.3):
`be6cd0c3c15e6d6236cadf3af0eb63332473f223c0713256f7a5b83e0fac2cf5`
(account-id form: base58 of the same 32 bytes — `accountIdBytes` accepts
either)

## Reading entries

```ts
import { RegistryClient } from '@widespread/lez-registry'

// `caller` is only needed for writes — pass a stub for read-only use.
const registry = new RegistryClient(
  { programCall: () => Promise.reject(new Error('read-only')) },
  { registryProgram: '<registry account id>', indexerUrl: 'https://testnet.lez.logos.co' },
)

// Deployer entry — created only by a chained call from the program itself
const entry = await registry.lookupDeployerEntry('<program id — hex or account id>')
// → { name, version, idlCid, sourceCid, repoUrl, commit, kind: 'deployer', … } | null

// Third-party entry — created by any signed account describing a program
const tp = await registry.lookupThirdPartyEntry('<program>', '<author account id>')
```

Lookups derive the entry PDA client-side and read the account directly —
no indexer-side registry awareness required. Empty accounts and
undecodable data return `null`.

## Writing entries

```ts
// Deployer entries can only be created by the program itself — the client
// submits a transaction to the PROGRAM's register_self hook, which emits
// a chained call carrying register_deployer into the registry.
await registry.registerDeployer('<program>', fields, { registerSelf: 1, updateSelf: 2 })
await registry.updateDeployer('<program>', fields, { registerSelf: 1, updateSelf: 2 })

// Third-party entries are a normal signed call into the registry.
await registry.registerThirdParty('<program>', '<author account>', fields)
await registry.updateThirdParty('<program>', '<author account>', fields)
```

`caller` is the small `ProgramCaller` signing interface — the Widespread
wallets (`wsp-lez` CLI, `wsp-lez-core` worker ops) implement it.

## Trusted-signer overlay

```ts
import { endorse, DEFAULT_TRUSTED_SIGNERS } from '@widespread/lez-registry'

const endorsed = endorse(tpEntry, { signers: ['<auditor account id>'] })
endorsed.trusted // boolean — badge, never a filter
```

Deployer entries are always `trusted` (self-authenticating on-chain);
third-party entries are trusted iff `entry.author` is in the overlay.
`DEFAULT_TRUSTED_SIGNERS` is empty — nothing hard-codes trust.

## IDL fetch + graceful degradation

```ts
const res = await registry.fetchIdl(entry, 'http://localhost:8080')
if (res.ok) decodeWithIdl(res.idl) // otherwise render raw instruction hex
```

Tries `/api/storage/v1` then `/api/codex/v1`, and local/network download
paths under each. Dead nodes, missing CIDs, and malformed JSON all
resolve `{ ok: false, error }` — a broken mirror never blocks a call.

## Helpers

`base58Encode/Decode`, `accountIdBytes` (accepts `Public/`/`Private/`
prefixed, bare base58, or 64-hex), `deployerEntryPda`,
`thirdPartyEntryPda`, `computePdaRaw`, plus the risc0-serde codecs
(`r0Str`, `r0U64`, `r0U8Array32`, `encodeInstruction`,
`instructionDataHex`) that encode instruction data byte-exactly to what
the SPEL guests expect.

## Authorization model (v3)

| Path | Gate |
|---|---|
| `register_deployer` / `update_deployer` | `caller_program_id == program` — only a chained call *from* the program itself satisfies it; top-level calls see the zero program id and are rejected |
| `register_self` / `update_self` (on each program) | ungated entry point that validates the entry PDA and emits the chained call |
| `register_third_party` / `update_third_party` | `author` signer; `author` is recorded in the entry |

Because deployment is unsigned, an on-chain "I am this program" proof is
only possible via `caller_program_id` — see `programs/registry/README.md`
and `programs/ARTIFACTS.md` for the full design record.
