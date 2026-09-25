/**
 * PRF-derived storage pointers — the zero-server location scheme.
 *
 * From the platform passkey's WebAuthn PRF output (32 bytes, obtained
 * client-side via navigator.credentials.get with the prf extension):
 *
 *   ptr   = SHA-256(HKDF-SHA256(prf, "wsp-ptr"))   — the S_id record pointer
 *   WK_id = HKDF-SHA256(prf, "wsp-wrap")           — the share-wrap key
 *
 * Everything is derived locally: no service maps user -> storage location,
 * and nobody who lacks the passkey can find or unwrap the share — including
 * us and the storage network.
 */

const HKDF_SALT = new Uint8Array(32) // salt-free HKDF: PRF output is already a strong key

async function hkdf(prfOutput: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey('raw', prfOutput.slice().buffer as ArrayBuffer, 'HKDF', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT.slice().buffer as ArrayBuffer,
      info: new TextEncoder().encode(info),
    },
    ikm,
    length * 8,
  )
  return new Uint8Array(bits)
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer),
  )
}

export interface PrfDerived {
  /** Storage pointer for the wrapped S_id record (hex). */
  ptr: string
  /** AES-256 key wrapping S_id. */
  wkId: CryptoKey
}

export async function deriveFromPrf(prfOutput: Uint8Array): Promise<PrfDerived> {
  if (prfOutput.length < 16) throw new Error('prf output too short')
  const ptrRaw = await sha256(await hkdf(prfOutput, 'wsp-ptr'))
  const wkBytes = await hkdf(prfOutput, 'wsp-wrap')
  const wkId = await crypto.subtle.importKey(
    'raw',
    wkBytes.slice().buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt'],
  )
  return {
    ptr: Array.from(ptrRaw, (b) => b.toString(16).padStart(2, '0')).join(''),
    wkId,
  }
}
