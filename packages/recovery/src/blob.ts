/**
 * Vault-blob backup sealing — the recoverable wallet state.
 *
 * The worker's exported blob is WalletCore-serialized storage (opaque,
 * holds key material). For remote recovery it is sealed under the
 * Shamir-split vault key K before upload: Logos Storage ever sees only
 * AES-GCM ciphertext, and K itself exists only inside the vault or as
 * reassembled shares. `sealBlob`/`openBlob` are byte-exact inverses.
 *
 * Blob layout: iv(12) || ct || tag — same convention as sealKit.
 */

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}
function b64encode(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

async function importK(vaultKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', vaultKey.slice().buffer as ArrayBuffer, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** Seal a base64 vault blob under the vault key K → opaque upload bytes. */
export async function sealBlob(blobB64: string, vaultKey: Uint8Array): Promise<Uint8Array> {
  const key = await importK(vaultKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const pt = b64decode(blobB64)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.slice().buffer as ArrayBuffer }, key, pt.slice().buffer as ArrayBuffer),
  )
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv, 0)
  out.set(ct, iv.length)
  return out
}

/** Open a sealed blob back to its base64 form. Throws on wrong K/tampering. */
export async function openBlob(sealed: Uint8Array, vaultKey: Uint8Array): Promise<string> {
  if (sealed.length <= 12) throw new Error('sealed blob too short')
  const key = await importK(vaultKey)
  const iv = sealed.slice(0, 12)
  const ct = sealed.slice(12)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.slice().buffer as ArrayBuffer },
    key,
    ct.slice().buffer as ArrayBuffer,
  )
  return b64encode(new Uint8Array(pt))
}
