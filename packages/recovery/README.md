# @widespread/recovery

Client-side vault recovery — passkeys, sealed recovery kits, and paired
devices. Everything runs in the user's context; Logos Storage holds only
ciphertext and the on-chain `pointer` program maps a PRF-derived lookup
key to a wrapped-share CID. There is no custodian and no backdoor: if all
recovery factors are lost, the wallet is **permanently unrecoverable**.

## Custody model

`enroll` / `onboardVault` split the vault key `K` into shares:

| Factor | Where it lives | Recovery path |
|---|---|---|
| `S_id` — passkey share | wrapped with the passkey-PRF-derived key, uploaded to Logos Storage, CID published at on-chain pointer `ptr` | synced passkey → PRF → `ptr` → resolve → download → unwrap |
| `S_dev` — device share | bound to the local passkey/session; transferable to a paired device over Logos Delivery | paired device transfers the factor |
| `S_rec` — kit share | sealed with the user's passphrase into a portable kit file | open kit → `shareCid`/`wkId` → unwrap → combine |

Two factors reconstruct `K`; any single factor is insufficient by design.

## API

```ts
import { onboardVault, recoverVault, createPasskeyWithPrf, getPasskeyPrf } from '@widespread/recovery'

// Enroll — after wallet init, while creating the passkey:
const result = await onboardVault(
  prfOutput,      // PRF output from createPasskeyWithPrf / getPasskeyPrf
  passphrase,     // user-chosen kit passphrase
  vaultBlobB64,   // current vault blob (base64 — as the worker exports it)
  storage,        // StorageClient (Logos Storage node)
)
// → { kitBytes, sDev, vaultKey, ptr, shareCid, blobCid, pointerValue }
// Host then publishes ptr → pointerValue ("shareCid:blobCid") via the
// pointer program once the account is funded.

// Recover — passkey path on a fresh device:
const restored = await recoverVault(
  {
    prfOutput,                    // same passkey, PRF output here
    pairedDeviceShare,            // optional S_dev from a paired device
  },
  storage,
  resolver,                       // PointerResolver — reads the on-chain pointer
)
// → { vaultKey, blobB64 } — feed blobB64 to backend.importBlob()

// Recover — kit path (no chain read needed, the kit carries its CIDs):
const restored2 = await recoverVault(
  { kit: { bytes: kitBytes, passphrase } },
  storage,
)
```

Lower-level pieces are exported for custom flows: `newVaultKey`,
`splitVaultKey` / `combineShares`, `deriveFromPrf`, `sealKit` / `openKit`,
`wrapShare` / `unwrapShare`, `sealBlob` / `openBlob`, `RestStorageClient`,
and the WebAuthn helpers `createPasskeyWithPrf` / `getPasskeyPrf` /
`passkeyPrfSupported`.

## Guarantees

- Passkey PRF output is used only as a *wrapping* key — it never becomes
  wallet key material.
- OAuth tokens (used elsewhere for social sign-in identity) never enter
  this package and never touch `K`.
- `ptr` is a PRF-derived lookup key, not a CID — the on-chain pointer
  reveals nothing about content or identity without the passkey.
- Kit files are passphrase-sealed (`openKit` fails on wrong passphrase);
  verified end-to-end against a live storage node including the
  negative cases.
