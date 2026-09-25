/**
 * Recovery kit — the second recovery factor.
 *
 * A kit carries everything needed to recover without a synced passkey:
 *
 *   { s_rec, ptr, wk_id, sealed_blob }
 *
 * sealed with AES-256-GCM under a PBKDF2(passphrase, salt, 600k) key, so the
 * kit file itself may live anywhere the user chooses (their own Drive /
 * iCloud / a USB stick — never our infrastructure).
 *
 * Layout (all lengths in bytes):
 *   magic "WSPK1" ‖ salt(16) ‖ nonce(12) ‖ ciphertext+tag
 * Plaintext payload is UTF-8 JSON: { v:1, sRec, ptr, wkId } (base64 fields).
 */

const MAGIC = new TextEncoder().encode('WSPK1')
const PBKDF2_ITERATIONS = 600_000

export interface RecoveryKitContents {
  /** S_rec share (base64). */
  sRec: string
  /** Derived pointer for on-chain ptr -> CID resolution (hex). */
  ptr: string
  /** S_id wrap key (base64 raw AES-256 key). */
  wkId: string
  /** CID of the wrapped S_id record — lets kit recovery skip the chain read. */
  shareCid: string
  /** CID of the K-sealed vault-blob backup — absent in pre-blob kits. */
  blobCid?: string
}

function b64encode(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

async function passphraseKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt.slice().buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Seal kit contents under `passphrase`. Returns the portable kit file bytes. */
export async function sealKit(contents: RecoveryKitContents, passphrase: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const key = await passphraseKey(passphrase, salt)
  const payload = new TextEncoder().encode(JSON.stringify({ v: 1, ...contents }))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, payload),
  )
  const out = new Uint8Array(MAGIC.length + salt.length + nonce.length + sealed.length)
  out.set(MAGIC, 0)
  out.set(salt, MAGIC.length)
  out.set(nonce, MAGIC.length + salt.length)
  out.set(sealed, MAGIC.length + salt.length + nonce.length)
  return out
}

/** Open a sealed kit. Throws on wrong passphrase or corrupt file. */
export async function openKit(kitBytes: Uint8Array, passphrase: string): Promise<RecoveryKitContents> {
  if (
    kitBytes.length < MAGIC.length + 28 ||
    !MAGIC.every((b, i) => kitBytes[i] === b)
  ) {
    throw new Error('not a Widespread recovery kit')
  }
  const salt = kitBytes.slice(MAGIC.length, MAGIC.length + 16)
  const nonce = kitBytes.slice(MAGIC.length + 16, MAGIC.length + 28)
  const sealed = kitBytes.slice(MAGIC.length + 28)
  const key = await passphraseKey(passphrase, salt)
  const payload = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, sealed),
  )
  const parsed = JSON.parse(new TextDecoder().decode(payload)) as RecoveryKitContents & {
    v: number
  }
  if (parsed.v !== 1) throw new Error(`unsupported kit version ${parsed.v}`)
  return {
    sRec: parsed.sRec,
    ptr: parsed.ptr,
    wkId: parsed.wkId,
    shareCid: parsed.shareCid ?? '',
    blobCid: parsed.blobCid || undefined,
  }
}

/** Wrap S_id under WK_id for upload to Logos Storage. */
export async function wrapShare(sId: Uint8Array, wkId: CryptoKey): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, wkId, sId.slice().buffer as ArrayBuffer),
  )
  const out = new Uint8Array(nonce.length + sealed.length)
  out.set(nonce, 0)
  out.set(sealed, nonce.length)
  return out
}

/** Unwrap a downloaded S_id ciphertext. */
export async function unwrapShare(wrapped: Uint8Array, wkId: CryptoKey): Promise<Uint8Array> {
  const nonce = wrapped.slice(0, 12)
  const sealed = wrapped.slice(12)
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, wkId, sealed),
  )
}

export const kitEncoding = { b64encode, b64decode }
