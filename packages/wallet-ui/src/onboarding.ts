/**
 * Onboarding orchestration — OAuth (convenience) → passkey PRF → vault →
 * recovery kit + share/blob backup → optional on-chain pointer publish.
 *
 * Custody rules enforced here:
 *   - OAuth is identity convenience ONLY — the token is shown to the user,
 *     never stored, and never becomes key material.
 *   - The passkey's PRF output stays in this client; it seeds the storage
 *     pointer + wrap key via HKDF, nothing leaves the device.
 *   - The kit (S_rec) is the user's portable second factor; losing every
 *     factor means permanent, designed unrecoverability.
 */

import {
  createPasskeyWithPrf,
  getPasskeyPrf,
  onboardVault,
  recoverVault,
  type PointerResolver,
  type StorageClient,
} from '@widespread/recovery'
import type { WalletBackend } from './backend'
import { computePublicPda } from './pda'

export interface SocialIdentity {
  provider: string
  /** OIDC subject / handle — display only. */
  subject?: string
  displayName?: string
}

/** Host-provided OAuth ceremony (chrome.identity / redirect / system browser). */
export type SocialSignInHook = (provider: 'google' | 'github') => Promise<SocialIdentity>

export interface SecretStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

/** localStorage-backed default for web/PWA surfaces. */
export class LocalSecretStore implements SecretStore {
  async get(key: string) {
    return globalThis.localStorage?.getItem(`wsp-lez-${key}`) ?? null
  }
  async set(key: string, value: string) {
    globalThis.localStorage?.setItem(`wsp-lez-${key}`, value)
  }
}

const b64encode = (b: Uint8Array): string => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}
const b64decode = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

// ── Pointer record (on-chain ptr → "shareCid:blobCid") ──────────────────

/** The pointer program's on-chain key: 32-char prefix of the 64-hex ptr
 *  (must fit a 32-byte string seed). Deterministic — the same ptr always
 *  maps to the same key. */
export function pointerKey(ptr: string): string {
  return ptr.slice(0, 32)
}

/** Resolve a derived ptr to its published "shareCid[:blobCid]" value. */
export function makePointerResolver(backend: WalletBackend, pointerProgramId: string): PointerResolver {
  return {
    async resolve(ptr: string) {
      if (!backend.accountRead) return null
      const pda = await computePublicPda(pointerProgramId, ['ptr', pointerKey(ptr)])
      const acc = await backend.accountRead(`Public/${pda}`).catch(() => null)
      if (!acc?.data_b64) return null
      const data = b64decode(acc.data_b64)
      // PointerRecord { publisher: [u8;32], value: String } — borsh.
      if (data.length < 36) return null
      const len = data[32] | (data[33] << 8) | (data[34] << 16) | (data[35] << 24)
      if (data.length < 36 + len) return null
      return new TextDecoder().decode(data.slice(36, 36 + len))
    },
  }
}

/** Publish ptr → pointerValue on-chain via the pointer program's
 *  `publish(key, value)` — needs a funded public `publisher` account. */
export async function publishPointer(
  backend: WalletBackend,
  pointerProgramId: string,
  publisher: string,
  ptr: string,
  pointerValue: string,
): Promise<string> {
  const key = pointerKey(ptr)
  const recordPda = await computePublicPda(pointerProgramId, ['ptr', key])
  // risc0-serde: variant 0 + r0Str(key) + r0Str(value) — words LE.
  const enc = new TextEncoder()
  const words: number[] = [0]
  for (const s of [key, pointerValue]) {
    const b = enc.encode(s)
    words.push(b.length)
    for (let i = 0; i < b.length; i += 4) {
      words.push((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24))
    }
  }
  const instructionDataHex = words
    .flatMap((w) => [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, (w >> 24) & 0xff])
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
  return backend.programCall(pointerProgramId, instructionDataHex, [
    { account: `Public/${recordPda}`, programAccountId: pointerProgramId },
    { account: publisher, programAccountId: pointerProgramId },
  ])
}

// ── Flows ───────────────────────────────────────────────────────────────

export interface NewVaultResult {
  mnemonic: string
  kitBytes: Uint8Array
  credentialId: Uint8Array
  ptr: string
  /** Publish this on-chain once a funded account exists (publishPointer). */
  pointerValue: string
}

/**
 * Create a fresh vault with full recovery setup:
 * passkey PRF → backend.init → blob export → split/seal/upload → kit.
 * The device share + credential id persist in `secrets` (inside the host's
 * own sealed vault surface — never in remote storage).
 */
export async function createWalletWithRecovery(opts: {
  backend: WalletBackend
  storage: StorageClient
  secrets: SecretStore
  userName: string
  kitPassphrase: string
  walletPassword?: string
}): Promise<NewVaultResult> {
  const { backend, storage, secrets } = opts
  if (!backend.exportBlob) throw new Error('backend cannot export the vault blob')

  const passkey = await createPasskeyWithPrf(opts.userName, opts.userName)
  const { mnemonic } = await backend.init(opts.walletPassword)
  const blobB64 = await backend.exportBlob()

  const res = await onboardVault(passkey.prfOutput, opts.kitPassphrase, blobB64, storage)

  await secrets.set('sDev', b64encode(res.sDev))
  await secrets.set('vaultKey', b64encode(res.vaultKey))
  await secrets.set('credentialId', b64encode(passkey.credentialId))

  return {
    mnemonic,
    kitBytes: res.kitBytes,
    credentialId: passkey.credentialId,
    ptr: res.ptr,
    pointerValue: res.pointerValue,
  }
}

/** Recover from a sealed kit (+ optional passkey/paired-device share). */
export async function recoverWalletWithKit(opts: {
  backend: WalletBackend
  storage: StorageClient
  secrets: SecretStore
  pointerProgramId: string
  kitBytes: Uint8Array
  kitPassphrase: string
}): Promise<void> {
  const { backend, storage, secrets, pointerProgramId } = opts
  if (!backend.importBlob) throw new Error('backend cannot import a vault blob')

  const pairedDeviceShare = await secrets
    .get('sDev')
    .then((s) => (s ? b64decode(s) : undefined))
  const resolver = makePointerResolver(backend, pointerProgramId)
  const { vaultKey, blobB64 } = await recoverVault(
    { kit: { bytes: opts.kitBytes, passphrase: opts.kitPassphrase }, pairedDeviceShare },
    storage,
    resolver,
  )
  if (!blobB64) throw new Error('recovery produced no vault blob — pointer not published?')
  await backend.importBlob(blobB64)
  await secrets.set('vaultKey', b64encode(vaultKey))
}

/** Recover via a synced passkey alone (needs the on-chain pointer). */
export async function recoverWalletWithPasskey(opts: {
  backend: WalletBackend
  storage: StorageClient
  secrets: SecretStore
  pointerProgramId: string
  credentialId?: Uint8Array
}): Promise<void> {
  const { backend, storage, secrets, pointerProgramId } = opts
  if (!backend.importBlob) throw new Error('backend cannot import a vault blob')

  const credId =
    opts.credentialId ??
    (await secrets.get('credentialId').then((s) => (s ? b64decode(s) : undefined)))
  if (!credId) throw new Error('no passkey enrolled on this device — use the recovery kit')
  const prfOutput = await getPasskeyPrf(credId)

  const pairedDeviceShare = await secrets
    .get('sDev')
    .then((s) => (s ? b64decode(s) : undefined))
  const resolver = makePointerResolver(backend, pointerProgramId)
  const { vaultKey, blobB64 } = await recoverVault(
    { prfOutput, pairedDeviceShare },
    storage,
    resolver,
  )
  if (!blobB64) throw new Error('recovery produced no vault blob — pointer not published?')
  await backend.importBlob(blobB64)
  await secrets.set('vaultKey', b64encode(vaultKey))
}
