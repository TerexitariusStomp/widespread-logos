/**
 * GatedBackend — the shared approval gate for wallet-initiated calls.
 *
 * Wraps a WalletBackend: before `transfer` or `program_call` reaches the
 * signer it builds a human-readable CallEffect (IDL-decoded when the
 * program publishes one through the on-chain registry), asks the host
 * surface to confirm it via `confirm(effect)`, and honors scoped session
 * grants so a confirmed call doesn't re-prompt on identical repeats.
 *
 * Trust boundary: on extension surfaces the authoritative gate lives in
 * the service worker (page-origin ops are gated there); this wrapper is
 * for surfaces where this UI IS the wallet front-end — module WebView,
 * PWA, Tauri — and for the popup's own send flow.
 */

import type { RegistryEntryLike, WalletBackend } from './backend'

// ── Call effects ────────────────────────────────────────────────────────

export interface CallEffect {
  kind: 'transfer' | 'program_call'
  /** One-line human summary, e.g. `testimonial.submit(text="…")`. */
  summary: string
  /** Program metadata from the on-chain registry, when resolvable. */
  program?: { name: string; version: string; verified: true }
  /** Decoded instruction name + args when the IDL was fetchable. */
  instruction?: string
  args?: Record<string, string>
  /** Hex fallback shown when decoding wasn't possible. */
  raw?: string
  warnings: string[]
}

export type { RegistryEntryLike }

export type ConfirmHook = (effect: CallEffect) => Promise<boolean>

export interface ApprovalHooks {
  confirm: ConfirmHook
  /** Codex/Logos Storage node base URL for IDL fetches. */
  storageNode?: string
}

// ── Scoped session grants ───────────────────────────────────────────────
//
// A confirmed program_call grants a short session for (scope=program).
// Repeats of calls to the SAME program within the TTL skip the prompt —
// the testimonial flow's submit+update cadence — while calls to a new
// program always prompt. Transfers never get a session: moving value
// always asks.

export interface SessionStore {
  get(scope: string): Promise<number | undefined>
  set(scope: string, expiresAt: number): Promise<void>
}

export class MemorySessionStore implements SessionStore {
  private grants = new Map<string, number>()
  async get(scope: string) {
    const exp = this.grants.get(scope)
    if (exp !== undefined && exp < Date.now()) {
      this.grants.delete(scope)
      return undefined
    }
    return exp
  }
  async set(scope: string, expiresAt: number) {
    this.grants.set(scope, expiresAt)
  }
}

const SESSION_TTL_MS = 15 * 60 * 1000

// ── risc0-serde instruction decoder (inverse of sdk/registry risc0.ts) ──

interface IdlArg {
  name: string
  type: unknown
}
interface IdlInstruction {
  name: string
  args: IdlArg[]
}
interface Idl {
  name?: string
  instructions: IdlInstruction[]
}

class WordReader {
  i = 0
  constructor(public words: Uint32Array) {}
  u32(): number {
    if (this.i >= this.words.length) throw new Error('instruction data truncated')
    return this.words[this.i++]
  }
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n)
    for (let k = 0; k < n; k += 4) {
      const w = this.u32()
      for (let j = 0; j < 4 && k + j < n; j++) out[k + j] = (w >>> (8 * j)) & 0xff
    }
    return out
  }
  string(): string {
    const len = this.u32()
    return new TextDecoder().decode(this.bytes(len))
  }
}

function decodeValue(r: WordReader, type: unknown): string {
  if (typeof type === 'string') {
    switch (type) {
      case 'bool':
        return r.u32() ? 'true' : 'false'
      case 'u8':
      case 'u16':
      case 'u32':
      case 'char':
        return String(r.u32())
      case 'u64':
      case 'i64': {
        const lo = BigInt(r.u32())
        const hi = BigInt(r.u32())
        return String((hi << 32n) | lo)
      }
      case 'u128': {
        let v = 0n
        for (let k = 0; k < 4; k++) v |= BigInt(r.u32()) << BigInt(32 * k)
        return String(v)
      }
      case 'string':
        return JSON.stringify(truncate(r.string()))
      default:
        return `<${type}:unsupported>`
    }
  }
  if (type && typeof type === 'object') {
    const t = type as Record<string, unknown>
    if (Array.isArray(t.array)) {
      const [el, n] = t.array as [unknown, number]
      const vals: string[] = []
      for (let k = 0; k < n; k++) vals.push(decodeValue(r, el))
      // [u8; 32] ids render as hex, not a 32-element list.
      if (el === 'u8' && n === 32) return `0x${vals.map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`
      return `[${vals.join(', ')}]`
    }
    if (t.vec !== undefined) {
      const len = r.u32()
      const vals: string[] = []
      for (let k = 0; k < len; k++) vals.push(decodeValue(r, t.vec))
      return `[${vals.join(', ')}]`
    }
    if (t.option !== undefined) {
      return r.u32() ? `Some(${decodeValue(r, t.option)})` : 'None'
    }
    if (t.defined !== undefined) return `<${String(t.defined)}:opaque>`
  }
  return '<unknown-type>'
}

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** Decode `instruction_data_hex` against a SPEL IDL. Throws on malformed input. */
export function decodeR0Instruction(dataHex: string, idl: Idl): { name: string; args: Record<string, string> } {
  const bytes = new Uint8Array(dataHex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16)
  const words = new Uint32Array(bytes.length / 4)
  for (let i = 0; i < words.length; i++) {
    words[i] = bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24)
  }
  const r = new WordReader(words)
  const index = r.u32()
  const ix = idl.instructions[index]
  if (!ix) throw new Error(`variant index ${index} out of range`)
  const args: Record<string, string> = {}
  for (const a of ix.args) args[a.name] = decodeValue(r, a.type)
  return { name: ix.name, args }
}

// ── IDL resolution via on-chain registry → Logos Storage ────────────────

const IDL_PATHS = ['/api/storage/v1/data', '/api/codex/v1/data']

async function fetchIdlByCid(storageNode: string, cid: string): Promise<Idl | null> {
  for (const p of IDL_PATHS) {
    try {
      const res = await fetch(`${storageNode.replace(/\/$/, '')}${p}/${cid}`)
      if (res.ok) return (await res.json()) as Idl
    } catch {
      /* node or path unavailable — try the next */
    }
  }
  return null
}

export class GatedBackend implements WalletBackend {
  constructor(
    private readonly inner: WalletBackend,
    private readonly hooks: ApprovalHooks,
    private readonly sessions: SessionStore = new MemorySessionStore(),
  ) {}

  // Optional surface methods delegate when the inner backend has them.
  get helperStatus() {
    return this.inner.helperStatus?.bind(this.inner)
  }
  get faucetDrop() {
    return this.inner.faucetDrop?.bind(this.inner)
  }
  get callModule() {
    return this.inner.callModule?.bind(this.inner)
  }
  get registryLookup() {
    return this.inner.registryLookup?.bind(this.inner)
  }

  // Pass-through ops — reads and vault management are not gated here.
  init(password?: string, zone?: string) {
    return this.inner.init(password, zone)
  }
  restore(mnemonic: string, password?: string, zone?: string) {
    return this.inner.restore(mnemonic, password, zone)
  }
  listAccounts() {
    return this.inner.listAccounts()
  }
  createAccount(label: string, isPrivate: boolean) {
    return this.inner.createAccount(label, isPrivate)
  }
  balance(account: string) {
    return this.inner.balance(account)
  }
  sync() {
    return this.inner.sync()
  }
  status() {
    return this.inner.status()
  }

  // ── Gated ops ─────────────────────────────────────────────────────────

  async transfer(from: string, to: string, amount: string): Promise<string> {
    const effect: CallEffect = {
      kind: 'transfer',
      summary: `Send ${amount} LEZ\nfrom ${from}\nto ${to}`,
      warnings: [],
    }
    if (!(await this.hooks.confirm(effect))) throw new Error('rejected by user')
    return this.inner.transfer(from, to, amount)
  }

  async programCall(
    program: string,
    instructionDataHex: string,
    accounts: Array<{ account: string; programAccountId: string }>,
    payer?: string,
  ): Promise<string> {
    const scope = `program_call:${program}`
    if ((await this.sessions.get(scope)) === undefined) {
      const effect = await this.describeCall(program, instructionDataHex)
      if (!(await this.hooks.confirm(effect))) throw new Error('rejected by user')
      await this.sessions.set(scope, Date.now() + SESSION_TTL_MS)
    }
    return this.inner.programCall(program, instructionDataHex, accounts, payer)
  }

  /** Build the human-readable effect for a program call. */
  async describeCall(program: string, dataHex: string): Promise<CallEffect> {
    const warnings: string[] = []
    const effect: CallEffect = {
      kind: 'program_call',
      summary: `program ${program.slice(0, 16)}…`,
      raw: dataHex,
      warnings,
    }
    let entry: RegistryEntryLike | null = null
    try {
      entry = (await this.inner.registryLookup?.(program)) ?? null
    } catch {
      /* registry unreachable — degrade, don't block */
    }
    if (!entry) {
      warnings.push('program has no on-chain registry entry — unverified')
      return effect
    }
    effect.program = { name: entry.name, version: entry.version, verified: true }
    if (!this.hooks.storageNode || !entry.idl_cid) {
      warnings.push('IDL unavailable — showing raw call data')
      return effect
    }
    const idl = await fetchIdlByCid(this.hooks.storageNode, entry.idl_cid)
    if (!idl) {
      warnings.push('IDL fetch failed — showing raw call data')
      return effect
    }
    try {
      const decoded = decodeR0Instruction(dataHex, idl)
      effect.instruction = decoded.name
      effect.args = decoded.args
      const argStr = Object.entries(decoded.args)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
      effect.summary = `${entry.name}.${decoded.name}(${truncate(argStr, 160)})`
    } catch {
      warnings.push('call data does not match the published IDL — showing raw hex')
    }
    return effect
  }
}
