/**
 * @widespread/lez-registry — LP-0023 program registry client.
 *
 * Registers and reads registry entries through the Widespread wallet
 * worker contract (ProgramCall ops) plus direct LEZ indexer queries —
 * no centralized registry service anywhere in the read or write path.
 *
 * On-chain layout (programs/registry):
 *   deployer_entry     PDA ["deployer_entry",     program]           (variant 0/2)
 *   third_party_entry  PDA ["third_party_entry",  program, author]   (variant 1/3)
 */

import {
  instructionDataHex,
  r0Str,
  r0U64,
  r0U8Array32,
  type R0Value,
} from './risc0.js'

// ── PDA derivation (mirrors packages/wallet-ui/src/pda.ts) ──────────────

const PDA_PREFIX = (() => {
  const p = new Uint8Array(32)
  p.set(new TextEncoder().encode('/LEE/v0.2/AccountId/PDA/'))
  return p
})()

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const B58_IDX = new Map(Array.from(B58).map((c, i) => [c, i]))

export function base58Decode(s: string): Uint8Array {
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros++
  const bytes: number[] = []
  for (let i = zeros; i < s.length; i++) {
    const v = B58_IDX.get(s[i])
    if (v === undefined) throw new Error(`invalid base58 char '${s[i]}'`)
    let carry = v
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  const out = new Uint8Array(zeros + bytes.length)
  out.set(bytes.reverse(), zeros)
  return out
}

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const digits: number[] = []
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]]
  return out
}

export function accountIdBytes(id: string): Uint8Array {
  const bare = id.replace(/^(Public|Private)\//, '')
  if (/^[0-9a-fA-F]{64}$/.test(bare)) {
    const out = new Uint8Array(32)
    for (let i = 0; i < 32; i++) out[i] = parseInt(bare.slice(i * 2, i * 2 + 2), 16)
    return out
  }
  const b = base58Decode(bare)
  if (b.length !== 32) throw new Error('account id must decode to 32 bytes')
  return b
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer))
}

function seedFromStr(s: string): Uint8Array {
  const src = new TextEncoder().encode(s)
  if (src.length > 32) throw new Error(`seed '${s}' exceeds 32 bytes`)
  const seed = new Uint8Array(32)
  seed.set(src)
  return seed
}

/** PDA over raw 32-byte seeds (account seeds are 32-byte account ids). */
export async function computePdaRaw(
  programId: string,
  seeds: Uint8Array[],
): Promise<string> {
  const program = accountIdBytes(programId)
  const combined =
    seeds.length === 1 ? seeds[0] : await sha256(Uint8Array.from(seeds.flatMap((s) => Array.from(s))))
  const input = new Uint8Array(96)
  input.set(PDA_PREFIX, 0)
  input.set(program, 32)
  input.set(combined, 64)
  return base58Encode(await sha256(input))
}

export const deployerEntryPda = (registryProgram: string, program: string) =>
  computePdaRaw(registryProgram, [seedFromStr('deployer_entry'), accountIdBytes(program)])

export const thirdPartyEntryPda = (registryProgram: string, program: string, author: string) =>
  computePdaRaw(registryProgram, [
    seedFromStr('third_party_entry'),
    accountIdBytes(program),
    accountIdBytes(author),
  ])

// ── Entry codec (borsh, mirrors RegistryEntry in registry.rs) ───────────

export interface RegistryEntryFields {
  name: string
  version: string
  description: string
  tags: string
  idlCid: string
  sourceCid: string
  repoUrl: string
  commit: string
  buildConfig: string
}

export interface RegistryEntry extends RegistryEntryFields {
  programId: string
  author: string
  kind: 'deployer' | 'third_party'
  registeredAt: bigint
}

export function encodeEntryFields(e: RegistryEntryFields, registeredAt: bigint): R0Value[] {
  return [
    r0Str(e.name),
    r0Str(e.version),
    r0Str(e.description),
    r0Str(e.tags),
    r0Str(e.idlCid),
    r0Str(e.sourceCid),
    r0Str(e.repoUrl),
    r0Str(e.commit),
    r0Str(e.buildConfig),
    r0U64(registeredAt),
  ]
}

export function decodeEntry(data: Uint8Array): RegistryEntry {
  let off = 0
  const u8 = () => data[off++]
  const u64 = () => {
    let v = 0n
    for (let i = 0; i < 8; i++) v |= BigInt(data[off++]) << BigInt(8 * i)
    return v
  }
  const take = (n: number) => {
    const s = data.slice(off, off + n)
    off += n
    return s
  }
  const str = () => {
    const len =
      data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)
    off += 4
    return new TextDecoder().decode(take(len))
  }
  const programId = base58Encode(take(32))
  const author = base58Encode(take(32))
  const kind = u8() === 0 ? 'deployer' : 'third_party'
  const entry: RegistryEntry = {
    programId,
    author,
    kind: kind as 'deployer' | 'third_party',
    name: str(),
    version: str(),
    description: str(),
    tags: str(),
    idlCid: str(),
    sourceCid: str(),
    repoUrl: str(),
    commit: str(),
    buildConfig: str(),
    registeredAt: u64(),
  }
  return entry
}

// ── Client ─────────────────────────────────────────────────────────────

/** Minimal transport: anything that can execute ProgramCall ops. */
export interface ProgramCaller {
  programCall(call: {
    program: string
    instruction_data_hex: string
    accounts: { account: string; program_account_id: string }[]
    payer?: string
  }): Promise<{ hash: string }>
}

export interface RegistryClientConfig {
  /** The registry program's on-chain account id (base58). */
  registryProgram: string
  /** LEZ indexer JSON-RPC endpoint (default: the zone's). */
  indexerUrl?: string
  /** LP-0022 zone selector — resolves the default indexer endpoint.
      `lez` (testnet) is the only named zone; anything else needs an
      explicit `indexerUrl`. */
  zone?: string
}

/**
 * Default indexer endpoints per zone (LP-0022). `lez` is the public
 * testnet; future zones register here, and custom/devnet zones pass an
 * explicit `indexerUrl` instead of a name.
 */
export const ZONE_INDEXERS: Record<string, string> = {
  lez: 'https://testnet.lez.logos.co',
  'lez-testnet': 'https://testnet.lez.logos.co',
}

/**
 * Registry instruction indices (generated-enum order in registry.rs):
 *   0 register_deployer   — chained-call only (caller_program_id gate)
 *   1 register_self       — top-level hook emitting the chained call
 *   2 register_third_party
 *   3 update_deployer     — chained-call only
 *   4 update_third_party
 *   5 update_self         — top-level hook emitting the chained call
 */
const REGISTRY_IX = {
  register_deployer: 0,
  register_self: 1,
  register_third_party: 2,
  update_deployer: 3,
  update_third_party: 4,
  update_self: 5,
} as const

/**
 * Per-program `register_self` / `update_self` indices (the hook's position
 * in each registrable program's own instruction enum — submit/publish/etc.
 * first, then the two self-registration hooks).
 */
export interface SelfRegisterIx {
  registerSelf: number
  updateSelf: number
}

export class RegistryClient {
  constructor(
    private readonly caller: ProgramCaller,
    private readonly cfg: RegistryClientConfig,
  ) {}

  private mention(account: string) {
    return { account, program_account_id: this.cfg.registryProgram }
  }

  /**
   * Register a program's deployer entry by invoking `register_self` on the
   * PROGRAM ITSELF (a public, unsigned call). The program emits a chained
   * call to the registry; the registry's caller_program_id check is the
   * on-chain deployer proof. `programAccount` is the canonical program id
   * (program-id bytes as an account id); `ix.registerSelf` is the
   * register_self index in that program's instruction enum (1 for the
   * Widespread programs and the registry itself).
   */
  async registerDeployer(
    programAccount: string,
    fields: RegistryEntryFields,
    ix: SelfRegisterIx,
    opts: { payer?: string; registeredAt?: bigint } = {},
  ): Promise<{ hash: string }> {
    const entry = await deployerEntryPda(this.cfg.registryProgram, programAccount)
    const registryBytes = accountIdBytes(this.cfg.registryProgram)
    return this.caller.programCall({
      program: programAccount,
      instruction_data_hex: instructionDataHex(ix.registerSelf, [
        r0U8Array32(registryBytes),
        ...encodeEntryFields(fields, opts.registeredAt ?? BigInt(Math.floor(Date.now() / 1000))),
      ]),
      // For programs that take `entry` as a declared mention (testimonial,
      // pointer, and the registry's own register_self).
      accounts: [{ account: entry, program_account_id: programAccount }],
      payer: opts.payer,
    })
  }

  async registerThirdParty(
    programAccount: string,
    authorAccount: string,
    fields: RegistryEntryFields,
    opts: { payer?: string; registeredAt?: bigint } = {},
  ): Promise<{ hash: string }> {
    const entry = await thirdPartyEntryPda(this.cfg.registryProgram, programAccount, authorAccount)
    return this.caller.programCall({
      program: this.cfg.registryProgram,
      instruction_data_hex: instructionDataHex(
        REGISTRY_IX.register_third_party,
        encodeEntryFields(fields, opts.registeredAt ?? BigInt(Math.floor(Date.now() / 1000))),
      ),
      accounts: [this.mention(entry), this.mention(programAccount), this.mention(authorAccount)],
      payer: opts.payer,
    })
  }

  /**
   * Update a deployer entry via the program's own `update_self` hook —
   * same chained-call proof as registration. `entry` is the live
   * deployer-entry account (declared mention, mutated by the registry).
   */
  async updateDeployer(
    programAccount: string,
    fields: Omit<RegistryEntryFields, 'name'>,
    ix: SelfRegisterIx,
    opts: { payer?: string } = {},
  ): Promise<{ hash: string }> {
    const entry = await deployerEntryPda(this.cfg.registryProgram, programAccount)
    const registryBytes = accountIdBytes(this.cfg.registryProgram)
    return this.caller.programCall({
      program: programAccount,
      instruction_data_hex: instructionDataHex(ix.updateSelf, [
        r0U8Array32(registryBytes),
        r0Str(fields.version),
        r0Str(fields.description),
        r0Str(fields.tags),
        r0Str(fields.idlCid),
        r0Str(fields.sourceCid),
        r0Str(fields.repoUrl),
        r0Str(fields.commit),
        r0Str(fields.buildConfig),
      ]),
      accounts: [{ account: entry, program_account_id: programAccount }],
      payer: opts.payer,
    })
  }

  async updateThirdParty(
    programAccount: string,
    authorAccount: string,
    fields: Omit<RegistryEntryFields, 'name'>,
    opts: { payer?: string } = {},
  ): Promise<{ hash: string }> {
    const entry = await thirdPartyEntryPda(this.cfg.registryProgram, programAccount, authorAccount)
    return this.caller.programCall({
      program: this.cfg.registryProgram,
      instruction_data_hex: instructionDataHex(REGISTRY_IX.update_third_party, [
        r0Str(fields.version),
        r0Str(fields.description),
        r0Str(fields.tags),
        r0Str(fields.idlCid),
        r0Str(fields.sourceCid),
        r0Str(fields.repoUrl),
        r0Str(fields.commit),
        r0Str(fields.buildConfig),
      ]),
      accounts: [this.mention(entry), this.mention(programAccount), this.mention(authorAccount)],
      payer: opts.payer,
    })
  }

  // ── Reads — direct against the LEZ indexer, no registry service ────────

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const zone = this.cfg.zone ?? 'lez'
    const url =
      this.cfg.indexerUrl ??
      ZONE_INDEXERS[zone] ??
      (() => {
        throw new Error(`unknown zone '${zone}' — pass an explicit indexerUrl`)
      })()
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const body = (await res.json()) as { result?: unknown; error?: { message: string } }
    if (body.error) throw new Error(`${method}: ${body.error.message}`)
    return body.result
  }

  /**
   * Look up an entry by account id. LEZ v0.2 `getAccount` returns the flat
   * account `{program_owner, balance, data, nonce}`; the registry entry is
   * borsh-decoded from `data` (a JSON byte array, or hex if the endpoint
   * encodes it as a string).
   */
  async lookupEntry(entryAccount: string): Promise<RegistryEntry | null> {
    const acct = (await this.rpc('getAccount', { account_id: entryAccount })) as {
      program_owner?: number[]
      balance?: number
      data?: number[] | string
      nonce?: number
    } | null
    if (!acct || acct.balance === undefined) return null
    const data = acct.data
    const bytes =
      typeof data === 'string'
        ? new Uint8Array(data.match(/../g)?.map((h) => parseInt(h, 16)) ?? [])
        : new Uint8Array(data ?? [])
    if (!bytes.length) return null
    try {
      return decodeEntry(bytes)
    } catch {
      // Uninitialized or foreign-owned account — graceful null.
      return null
    }
  }

  async lookupDeployerEntry(programAccount: string): Promise<RegistryEntry | null> {
    return this.lookupEntry(await deployerEntryPda(this.cfg.registryProgram, programAccount))
  }

  async lookupThirdPartyEntry(
    programAccount: string,
    authorAccount: string,
  ): Promise<RegistryEntry | null> {
    return this.lookupEntry(
      await thirdPartyEntryPda(this.cfg.registryProgram, programAccount, authorAccount),
    )
  }

  // ── IDL fetch (graceful — a dead mirror never blocks a call) ─────────

  /**
   * Fetch the IDL document for `entry.idlCid` from a Logos Storage node.
   * Tries each REST prefix (`/api/storage/v1`, then `/api/codex/v1` for
   * older nodes) × each download path (local, network stream, legacy
   * network). Any failure — dead node, missing CID, malformed JSON —
   * resolves to `{ ok: false, error }`; call-effect decoding falls back
   * to raw instruction hex rather than throwing.
   */
  async fetchIdl(entry: RegistryEntry, nodeUrl: string): Promise<IdlFetchResult> {
    const base = nodeUrl.replace(/\/$/, '')
    const cid = encodeURIComponent(entry.idlCid)
    let lastErr = 'no response'
    for (const prefix of STORAGE_PREFIXES) {
      for (const path of [`data/${cid}`, `data/${cid}/network/stream`, `data/${cid}/network`]) {
        try {
          const res = await fetch(`${base}${prefix}/${path}`)
          if (res.ok) return { ok: true, idl: await res.json() }
          lastErr = `HTTP ${res.status}`
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e)
        }
      }
    }
    return { ok: false, error: `idl ${entry.idlCid} not retrievable from ${nodeUrl}: ${lastErr}` }
  }
}

// ── Trusted-signer overlay (third-party entries) ────────────────────────

/**
 * `register_third_party` requires only the author's signature — anyone may
 * attest anything about any program. Trust in an attestation is a
 * client-side decision: `TrustedSignerOverlay` is a plain, inspectable
 * list of author account ids this deployment considers trustworthy.
 */
export interface TrustedSignerOverlay {
  signers: string[]
}

/** Empty by default — each deployment configures its own signer set. */
export const DEFAULT_TRUSTED_SIGNERS: readonly string[] = []

export interface EndorsedEntry extends RegistryEntry {
  /**
   * Deployer entries are always `trusted` — they are self-authenticating
   * (the chained `caller_program_id` proof). Third-party entries are
   * `trusted` iff `entry.author` is in the overlay's signer list.
   * Consumers display this as a badge, never as a filter — the overlay
   * annotates, it does not censor.
   */
  trusted: boolean
}

export function endorse(
  entry: RegistryEntry,
  overlay: TrustedSignerOverlay = { signers: [...DEFAULT_TRUSTED_SIGNERS] },
): EndorsedEntry {
  return {
    ...entry,
    trusted: entry.kind === 'deployer' || overlay.signers.includes(entry.author),
  }
}

export type IdlFetchResult = { ok: true; idl: unknown } | { ok: false; error: string }

const STORAGE_PREFIXES = ['/api/storage/v1', '/api/codex/v1'] as const

export * from './risc0.js'
