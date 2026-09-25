/**
 * PwaBackend — browser-surface backend for the standalone PWA / web wallet.
 *
 * Surface contract (same boundary as the extension's leak-guard tests):
 *   - READS: balances, account data, registry entries, faucet status go
 *     straight to the sequencer JSON-RPC — public data, no keys involved.
 *   - VIEWING: private outputs are decrypted client-side with the vendored
 *     `wsp-lez-wasm` codecs (upstream ML-KEM-768 + ChaCha20) using viewing
 *     keys extracted from an imported vault blob. Keys never leave the page.
 *   - VAULT BLOB: `importBlob` stores the upstream persistent-storage JSON in
 *     IndexedDB (sealed by the host page's own envelope upstream of this —
 *     the blob itself is the wallet's serialization, same as `exportBlob`).
 *   - SIGNING is not available on this surface: creating accounts, sending
 *     transfers and program calls require a signing surface (extension,
 *     Basecamp module, or the Tauri helper). They throw UnsupportedSurface
 *     so the UI can render a clear "open in the extension" affordance
 *     instead of a generic failure.
 */

import type { WalletBackend, LezAccount, RegistryEntryLike } from './backend'

export class UnsupportedSurfaceError extends Error {
  readonly code = 'unsupported_surface'
  constructor(op: string) {
    super(
      `${op} requires a signing surface — open the wallet in the browser ` +
        `extension, Logos Basecamp, or the desktop app to send transactions.`,
    )
    this.name = 'UnsupportedSurfaceError'
  }
}

export interface PwaBackendOptions {
  /** LEZ sequencer JSON-RPC endpoint. */
  sequencerUrl?: string
  /** LP-0022 zone selector — resolves the default sequencer endpoint
      (`lez` testnet). `sequencerUrl` wins when both are set; unknown
      zones require it. */
  zone?: string
  /** LP-0023 registry program account id (base58) for deployer lookups. */
  registryProgram?: string
  /** URL of `wsp_lez_wasm_bg.wasm` — required for `scanPrivateOutputs`. */
  wasmUrl?: string
}

const ZONE_SEQUENCERS: Record<string, string> = {
  lez: 'https://testnet.lez.logos.co',
  'lez-testnet': 'https://testnet.lez.logos.co',
}
const DEFAULT_SEQUENCER = ZONE_SEQUENCERS.lez
/** Fixed system account holding the pinata challenge (system_accounts.rs). */
const PINATA_ACCOUNT = 'EfQhKQAkX2FJiwNii2WFQsGndjvF1Mzd7RuVe7QdPLw7'
const PINATA_PRIZE = 150n
const MAX_SUPPORTED_DIFFICULTY = 3

// ── IndexedDB kv ─────────────────────────────────────────────────────────

const DB_NAME = 'widespread-wallet-pwa'
const STORE = 'kv'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ── helpers ──────────────────────────────────────────────────────────────

const hex = (bytes: number[] | string | undefined): string =>
  typeof bytes === 'string'
    ? bytes
    : Array.from(bytes ?? [], (b) => b.toString(16).padStart(2, '0')).join('')

const b64 = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

interface FlatAccount {
  program_owner?: number[] | string
  balance?: number | string
  data?: number[] | string
  nonce?: number
}

export interface ViewingKeys {
  dHex: string
  zHex: string
  npkHex: string
  vpkHex: string
}

export interface DecryptedNote {
  kind: unknown
  account: unknown
  accountId: string
}

export class PwaBackend implements WalletBackend {
  private readonly sequencer: string
  private readonly registryProgram?: string
  private readonly wasmUrl?: string

  constructor(opts: PwaBackendOptions = {}) {
    this.sequencer =
      opts.sequencerUrl ?? ZONE_SEQUENCERS[opts.zone ?? 'lez'] ??
      (() => {
        throw new Error(`unknown zone '${opts.zone}' — pass an explicit sequencerUrl`)
      })()
    this.registryProgram = opts.registryProgram
    this.wasmUrl = opts.wasmUrl
  }

  // ── signing-surface ops — intentionally unsupported ────────────────────

  init(): Promise<{ mnemonic: string }> {
    return Promise.reject(new UnsupportedSurfaceError('init'))
  }
  restore(): Promise<void> {
    return Promise.reject(new UnsupportedSurfaceError('restore'))
  }
  createAccount(): Promise<string> {
    return Promise.reject(new UnsupportedSurfaceError('createAccount'))
  }
  sync(): Promise<number> {
    return Promise.reject(new UnsupportedSurfaceError('sync'))
  }
  transfer(): Promise<string> {
    return Promise.reject(new UnsupportedSurfaceError('transfer'))
  }
  programCall(): Promise<string> {
    return Promise.reject(new UnsupportedSurfaceError('programCall'))
  }

  // ── sequencer reads ────────────────────────────────────────────────────

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const res = await fetch(this.sequencer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const body = (await res.json()) as { result?: unknown; error?: { message: string } }
    if (body.error) throw new Error(`${method}: ${body.error.message}`)
    return body.result
  }

  private async getAccount(accountId: string): Promise<FlatAccount | null> {
    return (await this.rpc('getAccount', { account_id: accountId })) as FlatAccount | null
  }

  async status(): Promise<{ sequencer: string }> {
    return { sequencer: this.sequencer }
  }

  async balance(account: string): Promise<string> {
    const acct = await this.getAccount(account)
    return String(acct?.balance ?? '0')
  }

  async accountRead(account: string): Promise<{
    data_b64: string
    program_owner: string
    balance: string
    nonce: number
  }> {
    const acct = await this.getAccount(account)
    const data =
      typeof acct?.data === 'string'
        ? new Uint8Array(acct.data.match(/../g)?.map((h) => parseInt(h, 16)) ?? [])
        : new Uint8Array(acct?.data ?? [])
    return {
      data_b64: b64(data),
      program_owner: hex(acct?.program_owner),
      balance: String(acct?.balance ?? '0'),
      nonce: acct?.nonce ?? 0,
    }
  }

  /** Pinata faucet status — same reads as `wsp-lez-core::faucet_info`. */
  async faucetInfo(): Promise<{
    pool: string
    claims: string
    difficulty: number
    available: boolean
    blocked_reason?: string
  }> {
    const acct = await this.getAccount(PINATA_ACCOUNT)
    const data = typeof acct?.data === 'string'
      ? new Uint8Array(acct.data.match(/../g)?.map((h) => parseInt(h, 16)) ?? [])
      : new Uint8Array(acct?.data ?? [])
    const pool = BigInt(acct?.balance ?? 0)
    const difficulty = data.length === 33 ? data[0] : 0
    const blocked =
      pool < PINATA_PRIZE
        ? 'pool_depleted'
        : difficulty > MAX_SUPPORTED_DIFFICULTY
          ? 'unsupported_difficulty'
          : undefined
    return {
      pool: pool.toString(),
      claims: (pool / PINATA_PRIZE).toString(),
      difficulty,
      available: blocked === undefined,
      blocked_reason: blocked,
    }
  }

  async registryLookup(program: string): Promise<RegistryEntryLike | null> {
    if (!this.registryProgram) return null
    // Read-only path — the caller stub is never invoked for lookups.
    const { RegistryClient } = await import('@widespread/lez-registry')
    const client = new RegistryClient(
      { programCall: () => Promise.reject(new UnsupportedSurfaceError('programCall')) },
      { registryProgram: this.registryProgram, indexerUrl: this.sequencer },
    )
    const entry = await client.lookupDeployerEntry(program)
    if (!entry) return null
    return {
      name: entry.name,
      version: entry.version,
      idl_cid: entry.idlCid,
      kind: entry.kind,
    }
  }

  // ── watched accounts (no key material beyond viewing keys) ────────────

  async listAccounts(): Promise<LezAccount[]> {
    return (await idbGet<LezAccount[]>('accounts')) ?? []
  }

  /** Watch an account id without importing keys (public-view surface). */
  async watchAccount(label: string, accountId: string): Promise<void> {
    const accts = await this.listAccounts()
    if (!accts.some((a) => a.accountId === accountId)) {
      accts.push({ label, accountId })
      await idbSet('accounts', accts)
    }
  }

  /**
   * Import an upstream persistent-storage blob (the `exportBlob` payload —
   * plaintext serialization produced by a signing surface). Extracts the
   * address book and private viewing keys; the raw blob is kept for
   * re-export. Signing keys present in the blob are never read or used.
   */
  async importBlob(blobB64: string): Promise<void> {
    const parsed = JSON.parse(new TextDecoder().decode(b64ToBytes(blobB64))) as {
      key_chain?: { accounts?: Record<string, unknown>[] }
      labels?: Record<string, unknown>
    }
    const accounts: LezAccount[] = []
    const viewKeys: Record<string, ViewingKeys> = {}
    for (const entry of parsed.key_chain?.accounts ?? []) {
      const variant = (entry['Public'] ??
        entry['Private'] ??
        entry['ImportedPublic'] ??
        entry['ImportedPrivate']) as
        | {
            account_id?: string
            data?: { value?: [{ private_key_holder?: { viewing_secret_key?: { d?: number[]; z?: number[] } }; nullifier_public_key?: number[]; viewing_public_key?: number[] }, unknown[]] }
          }
        | undefined
      const accountId = variant?.account_id
      if (typeof accountId !== 'string') continue
      const label =
        Object.entries(parsed.labels ?? {}).find(([, v]) =>
          JSON.stringify(v).includes(accountId),
        )?.[0] ?? accountId.slice(0, 8)
      accounts.push({ label, accountId })
      const kc = variant?.data?.value?.[0]
      const vsk = kc?.private_key_holder?.viewing_secret_key
      if (vsk?.d && vsk?.z && kc?.nullifier_public_key && kc?.viewing_public_key) {
        viewKeys[accountId] = {
          dHex: hex(vsk.d),
          zHex: hex(vsk.z),
          npkHex: hex(kc.nullifier_public_key),
          vpkHex: hex(kc.viewing_public_key),
        }
      }
    }
    await idbSet('accounts', accounts)
    await idbSet('viewkeys', viewKeys)
    await idbSet('blob', { blobB64, importedAt: Date.now() })
  }

  async exportBlob(): Promise<string> {
    const blob = await idbGet<{ blobB64: string }>('blob')
    if (!blob) throw new Error('no vault blob imported on this surface')
    return blob.blobB64
  }

  /** Viewing keys for an imported private account (client-side scan only). */
  async viewingKeys(accountId: string): Promise<ViewingKeys | null> {
    // The blob stores bare base58 ids; callers may pass the Public/Private-
    // prefixed wire form — normalize before lookup.
    const bare = accountId.replace(/^(Public|Private)\//, '')
    const keys = await idbGet<Record<string, ViewingKeys>>('viewkeys')
    return keys?.[bare] ?? keys?.[accountId] ?? null
  }

  /**
   * Decrypt private outputs with the vendored upstream codecs. `actions`
   * are `{ead_borsh_hex, nullifier_hex}` pairs gathered by the caller from
   * on-chain messages; non-matching outputs return null (skipped), matching
   * the wallet's own scan behavior.
   */
  async scanPrivateOutputs(
    accountId: string,
    actions: { ead_borsh_hex: string; nullifier_hex: string }[],
  ): Promise<DecryptedNote[]> {
    const keys = await this.viewingKeys(accountId)
    if (!keys) throw new Error(`no viewing keys for ${accountId} — import the vault blob first`)
    if (!this.wasmUrl) throw new Error('wasmUrl not configured')
    const wasm = await import('@widespread/lez-wasm')
    await wasm.default(this.wasmUrl)
    const notes: DecryptedNote[] = []
    for (const a of actions) {
      const decrypted = wasm.decrypt_private_output(
        a.ead_borsh_hex,
        keys.dHex,
        keys.zHex,
        a.nullifier_hex,
      )
      if (decrypted === undefined) continue
      const { kind, account } = JSON.parse(decrypted) as { kind: unknown; account: unknown }
      const id = wasm.private_account_id_b58(keys.npkHex, keys.vpkHex, JSON.stringify(kind))
      if (id !== undefined) notes.push({ kind, account, accountId: id })
    }
    return notes
  }
}
