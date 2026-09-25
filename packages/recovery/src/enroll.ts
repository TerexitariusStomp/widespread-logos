/**
 * Enrollment & recovery orchestration — the custody model end to end.
 *
 * Logos Storage is content-addressed, so the PRF-derived `ptr` is not a
 * CID itself — it is the seed of an on-chain pointer record (the
 * `pointer` SPEL program, PDA ["ptr", ptr]) that maps ptr -> the wrapped
 * share's CID. Enrollment returns the CID so the host can publish the
 * pointer with a funded account; recovery resolves it back.
 *
 * Enroll (new wallet):
 *   K = newVaultKey()
 *   {sId, sDev, sRec} = split(K)
 *   {ptr, wkId} = deriveFromPrf(passkey PRF output)
 *   shareCid = upload(wrapShare(sId, wkId))
 *   publish ptr -> shareCid on-chain (host does this once funded)
 *   kit = sealKit({sRec, ptr, wkId, shareCid}, passphrase) -> user keeps it
 *
 * Recover via synced passkey:  PRF -> ptr/wkId -> resolve ptr -> download ->
 *                              unwrap -> shares -> K
 * Recover via kit:             openKit -> sRec + shareCid + wkId -> unwrap ->
 *                              shares -> K   (no chain read needed — the kit
 *                              carries the CID it sealed at enrollment)
 * Recover via paired device:   the device transfers a factor over Delivery
 *
 * If none of the three factors survives, the wallet is unrecoverable —
 * permanently, by design. There is no custodian and no backdoor.
 */

import { openBlob, sealBlob } from './blob'
import { deriveFromPrf } from './derive'
import { openKit, sealKit, unwrapShare, wrapShare, type RecoveryKitContents } from './kit'
import { combineShares, newVaultKey, splitVaultKey } from './shares'
import type { StorageClient } from './storage'

export interface EnrollResult {
  /** The S_rec/passphrase-sealed kit file bytes for the user to keep. */
  kitBytes: Uint8Array
  /** The device share — bound to the local passkey/session. */
  sDev: Uint8Array
  /** The vault key — lives in the sealed vault, never persisted raw. */
  vaultKey: Uint8Array
  /** The derived pointer — the host publishes ptr -> shareCid on-chain. */
  ptr: string
  /** CID of the wrapped S_id record on Logos Storage. */
  shareCid: string
}

/** Resolves a derived pointer to its published CID (on-chain read). */
export interface PointerResolver {
  resolve(ptr: string): Promise<string | null>
}

/** Create a vault key, split it, and publish the wrapped S_id ciphertext. */
export async function enroll(
  prfOutput: Uint8Array,
  passphrase: string,
  storage: StorageClient,
): Promise<EnrollResult> {
  const vaultKey = newVaultKey()
  const { sId, sDev, sRec } = await splitVaultKey(vaultKey)
  const { ptr, wkId } = await deriveFromPrf(prfOutput)
  const shareCid = await storage.upload(await wrapShare(sId, wkId))
  const kitBytes = await sealKit(
    {
      sRec: b64(sRec),
      ptr,
      wkId: b64(await exportRawKey(wkId)),
      shareCid,
    },
    passphrase,
  )
  return { kitBytes, sDev, vaultKey, ptr, shareCid }
}

export interface OnboardResult extends EnrollResult {
  /** CID of the K-sealed vault-blob backup. */
  blobCid: string
  /** On-chain pointer value: `${shareCid}:${blobCid}` — one publish covers both. */
  pointerValue: string
}

/**
 * Full enrollment for a new vault: split K, upload the wrapped identity
 * share AND the K-sealed vault blob, seal a kit that carries both CIDs.
 * The returned `pointerValue` is what the host publishes at PDA
 * ["ptr", ptr] once a funded account exists.
 */
export async function onboardVault(
  prfOutput: Uint8Array,
  passphrase: string,
  vaultBlobB64: string,
  storage: StorageClient,
): Promise<OnboardResult> {
  const vaultKey = newVaultKey()
  const { sId, sDev, sRec } = await splitVaultKey(vaultKey)
  const { ptr, wkId } = await deriveFromPrf(prfOutput)
  const shareCid = await storage.upload(await wrapShare(sId, wkId))
  const blobCid = await storage.upload(await sealBlob(vaultBlobB64, vaultKey))
  const kitBytes = await sealKit(
    {
      sRec: b64(sRec),
      ptr,
      wkId: b64(await exportRawKey(wkId)),
      shareCid,
      blobCid,
    },
    passphrase,
  )
  return {
    kitBytes,
    sDev,
    vaultKey,
    ptr,
    shareCid,
    blobCid,
    pointerValue: `${shareCid}:${blobCid}`,
  }
}

/**
 * Recover the vault key AND the sealed-blob backup: returns the restored
 * `blob_b64` ready for a worker `unlock` op. The pointer record's value is
 * `${shareCid}:${blobCid}`; kits minted before blob backups carry only
 * shareCid and recover the key alone (blob restore then needs a re-export
 * from a surviving device).
 */
export async function recoverVault(
  factors: {
    prfOutput?: Uint8Array
    kit?: { bytes: Uint8Array; passphrase: string }
    pairedDeviceShare?: Uint8Array
  },
  storage: StorageClient,
  resolver?: PointerResolver,
): Promise<{ vaultKey: Uint8Array; blobB64: string | null }> {
  const contents = factors.kit
    ? await openKit(factors.kit.bytes, factors.kit.passphrase)
    : undefined
  const ptr =
    contents?.ptr ?? (factors.prfOutput ? (await deriveFromPrf(factors.prfOutput)).ptr : undefined)

  let blobCid = contents?.blobCid || undefined
  if (!blobCid && ptr && resolver) {
    blobCid = ((await resolver.resolve(ptr)) ?? undefined)?.split(':')[1]
  }

  const { vaultKey } = await recover(
    {
      prfOutput: factors.prfOutput,
      kit: contents ? { contents } : undefined,
      pairedDeviceShare: factors.pairedDeviceShare,
    },
    storage,
    resolver,
  )
  if (!blobCid) return { vaultKey, blobB64: null }
  const sealed = await storage.download(blobCid)
  return { vaultKey, blobB64: await openBlob(sealed, vaultKey) }
}

/**
 * Recover the vault key from whatever factors remain — a synced passkey's
 * PRF output (resolves ptr on-chain), an opened kit (carries the CID), or
 * a paired-device share. Throws when fewer than two shares assemble.
 */
export async function recover(
  factors: {
    prfOutput?: Uint8Array
    kit?: { bytes: Uint8Array; passphrase: string } | { contents: RecoveryKitContents }
    pairedDeviceShare?: Uint8Array
  },
  storage: StorageClient,
  resolver?: PointerResolver,
): Promise<{ vaultKey: Uint8Array }> {
  let sRec: Uint8Array | undefined
  let ptr: string | undefined
  let shareCid: string | undefined
  let wkId: CryptoKey | undefined

  if (factors.kit) {
    const contents: RecoveryKitContents =
      'contents' in factors.kit
        ? factors.kit.contents
        : await openKit(factors.kit.bytes, factors.kit.passphrase)
    sRec = unb64(contents.sRec)
    ptr = contents.ptr
    shareCid = contents.shareCid || undefined
    wkId = await importRawKey(unb64(contents.wkId))
  }
  if (factors.prfOutput) {
    const derived = await deriveFromPrf(factors.prfOutput)
    ptr ??= derived.ptr
    wkId ??= derived.wkId
  }
  if (!shareCid && ptr && resolver) {
    // Pointer values are `shareCid` or `shareCid:blobCid` — the share is
    // always the first segment.
    shareCid = (await resolver.resolve(ptr))?.split(':')[0] ?? undefined
  }

  const shares: Uint8Array[] = []
  if (sRec) shares.push(sRec)
  if (factors.pairedDeviceShare) shares.push(factors.pairedDeviceShare)

  if (shareCid && wkId) {
    const wrapped = await storage.download(shareCid)
    shares.push(await unwrapShare(wrapped, wkId))
  }

  if (shares.length < 2) {
    throw new Error(
      'unrecoverable: fewer than two factors remain (need passkey, kit, or a paired device)',
    )
  }
  return { vaultKey: await combineShares(shares) }
}

function b64(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key))
}

async function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw.slice().buffer as ArrayBuffer, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ])
}
