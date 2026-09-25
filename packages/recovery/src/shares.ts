/**
 * Vault-key share split/combine — 2-of-3 Shamir over GF(256).
 *
 *   K      — the vault key (32 random bytes), never leaves the client
 *   S_id   — identity share: stored on Logos Storage, wrapped by WK_id
 *   S_dev  — device share: derived/held by the platform passkey (PRF)
 *   S_rec  — recovery-kit share: exported to the user's own storage
 *
 * Any two of the three reconstruct K. One share alone is information-
 * theoretically useless — Logos Storage ciphertext plus one share reveals
 * nothing.
 */

import { combine, split } from 'shamir-secret-sharing'

export interface ShareSet {
  sId: Uint8Array
  sDev: Uint8Array
  sRec: Uint8Array
}

/** Split a 32-byte vault key into its three shares. */
export async function splitVaultKey(key: Uint8Array): Promise<ShareSet> {
  if (key.length < 16) throw new Error('vault key too short')
  const [sId, sDev, sRec] = await split(key, 3, 2)
  return { sId, sDev, sRec }
}

/** Reconstruct the vault key from any two (or more) shares. */
export async function combineShares(shares: Uint8Array[]): Promise<Uint8Array> {
  if (shares.length < 2) throw new Error('need at least two shares')
  return combine(shares)
}

/** Generate a fresh vault key. */
export function newVaultKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}
