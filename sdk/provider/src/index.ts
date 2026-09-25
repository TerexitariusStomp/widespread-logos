/**
 * Widespread LEZ Wallet Provider SDK.
 *
 * DApp-facing API (spec LP-0021 Wallet Provider SDK):
 *   connect(dappInfo) -> accounts (approval-gated)
 *   getAccounts / getBalance (private balances gated)
 *   proposeTransaction(call) -> approve/reject -> submit -> hash
 *   events: accountsChanged, txPending, txConfirmed
 *
 * The transport is the page<->extension bridge used by every other chain:
 * window events relayed by the content script to background dispatch.
 * On surfaces without the extension (Basecamp WebView, Tauri), the same
 * API is served over the module bridge (logos.callModuleAsync) — the SDK
 * picks whichever transport is present.
 */

export interface DappInfo {
  name?: string
  url?: string
  icon?: string
}

export interface ProgramCallSpec {
  program: string
  /** LEZ instruction bytes (hex). */
  instructionDataHex: string
  accounts: Array<{ account: string; programAccountId: string }>
  payer?: string
}

export interface TransferSpec {
  from: string
  to?: string
  toPrivate?: { npk: unknown; vpk: unknown; identifier: unknown }
  amount: string
}

export type LezEvent = 'accountsChanged' | 'txPending' | 'txConfirmed'
type Handler = (data: unknown) => void

interface Bridge {
  call(op: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: LezEvent, handler: Handler): void
}

// ── Extension bridge (ROOTED_WALLET_REQUEST/RESPONSE postMessage) ────────
//
// Same wire protocol as the injected EIP-1193/Solana providers: the page
// posts {type:'ROOTED_WALLET_REQUEST', id, method, params}; the content
// script whitelists method via METHOD_MAP (lez_* ops), forwards to the
// service worker, and answers ROOTED_WALLET_RESPONSE_<id>. Page JS can
// never reach a non-whitelisted background op through this path.

let extSeq = 0

function extensionBridge(): Bridge | null {
  if (typeof window === 'undefined' || typeof window.postMessage !== 'function') return null
  // The injected provider marks itself — without it postMessage goes nowhere.
  if (!(window as { widespreadWallet?: { isWidespread?: boolean } }).widespreadWallet?.isWidespread)
    return null
  return {
    call(op, params) {
      const id = `lez-${++extSeq}-${Date.now()}`
      return new Promise((resolve, reject) => {
        const handler = (ev: MessageEvent) => {
          const d = (ev as MessageEvent).data
          if (d?.type !== `ROOTED_WALLET_RESPONSE_${id}`) return
          window.removeEventListener('message', handler)
          const r = d.response
          if (r?.error) reject(new Error(r.error))
          else resolve(r && typeof r === 'object' && 'result' in r ? r.result : r)
        }
        window.addEventListener('message', handler)
        window.postMessage(
          { type: 'ROOTED_WALLET_REQUEST', id, method: op, params },
          window.location.origin,
        )
        setTimeout(() => {
          window.removeEventListener('message', handler)
          reject(new Error('lez: extension did not respond'))
        }, 120_000)
      })
    },
    on(event, handler) {
      window.addEventListener('message', (ev) => {
        const d = (ev as MessageEvent).data
        if (d?.target === 'wsp-lez-event' && d.event === event) handler(d.data)
      })
    },
  }
}

// ── Logos module bridge (Basecamp WebView: logos.callModuleAsync) ─────────

declare global {
  interface Window {
    logos?: {
      callModuleAsync: (
        module: string,
        method: string,
        args: unknown[],
        cb: (result: string) => void,
      ) => void
      /** QML-side synchronous variant used by some hosts. */
      callModule?: (module: string, method: string, args: unknown[]) => string
    }
  }
}

function moduleBridge(): Bridge | null {
  if (typeof window === 'undefined' || !window.logos?.callModuleAsync) return null
  return {
    call(op, params) {
      return new Promise((resolve, reject) => {
        try {
          window.logos!.callModuleAsync(
            'widespread_wallet',
            'callPluginMethod',
            [op, JSON.stringify(params ?? {})],
            (result) => {
              try {
                const parsed = JSON.parse(result)
                if (parsed.error) reject(new Error(parsed.error))
                else resolve(parsed)
              } catch {
                resolve(result)
              }
            },
          )
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    },
    on(event, handler) {
      window.addEventListener('message', (ev) => {
        const d = (ev as MessageEvent).data
        if (d?.type === 'wsp-module-event' && d.event === event) handler(d.data)
      })
    },
  }
}

// ── Public SDK ─────────────────────────────────────────────────────────────

export class WidespreadLezProvider {
  private bridge: Bridge
  private connected = false

  constructor() {
    const b = moduleBridge() ?? extensionBridge()
    if (!b) throw new Error('wsp-lez: no wallet transport (extension or Logos module) detected')
    this.bridge = b
  }

  /** Whether the page can reach a wallet at all (extension or module). */
  static isAvailable(): boolean {
    return moduleBridge() !== null || extensionBridge() !== null
  }

  /**
   * Connect: if the wallet is locked/absent the wallet UI opens onboarding
   * inline; the returned accounts are usable immediately after approval.
   *
   * `opts.zone` is the LP-0022 zone selector forwarded to hosts that
   * support it (zones are session-scoped — set at wallet init/unlock;
   * the default is `lez`, the public testnet).
   */
  async connect(info: DappInfo = {}, opts: { zone?: string } = {}): Promise<string[]> {
    const out = (await this.bridge.call('lez_requestAccounts', {
      zone: opts.zone,
    })) as
      | { accounts?: string[] }
      | string[]
    const accounts = Array.isArray(out) ? out : (out.accounts ?? [])
    this.connected = accounts.length > 0
    return accounts
  }

  async getAccounts(): Promise<string[]> {
    const out = (await this.bridge.call('lez_accounts', {})) as { accounts?: string[] } | string[]
    return Array.isArray(out) ? out : (out.accounts ?? [])
  }

  /** Public balance for any account; private balances require connect(). */
  async getBalance(account: string): Promise<string> {
    const out = await this.bridge.call('lez_getBalance', { account })
    return String(out)
  }

  /**
   * Propose + submit a native transfer. Approval happens in the wallet UI;
   * this resolves with the tx hash once submitted.
   */
  async transfer(t: TransferSpec): Promise<string> {
    this.emit('txPending', t)
    const hash = (await this.bridge.call('lez_sendTransaction', {
      from: t.from,
      to: t.to,
      amount: t.amount,
    })) as string
    this.emit('txConfirmed', { hash })
    return hash
  }

  /** Propose + submit a program call. */
  async proposeTransaction(call: ProgramCallSpec): Promise<string> {
    this.emit('txPending', call)
    const hash = (await this.bridge.call('lez_programCall', {
      program: call.program,
      instructionDataHex: call.instructionDataHex,
      accounts: call.accounts,
      payer: call.payer,
    })) as string
    this.emit('txConfirmed', { hash })
    return hash
  }

  /** Testnet faucet (Piñata) state — pool, difficulty, eligibility. */
  async faucetInfo(): Promise<{
    prize: string
    pool_balance: string
    claims_remaining: string
    difficulty_bytes: number
    can_claim: boolean
    blocked_reason: string
  }> {
    return (await this.bridge.call('lez_faucetInfo', {})) as {
      prize: string
      pool_balance: string
      claims_remaining: string
      difficulty_bytes: number
      can_claim: boolean
      blocked_reason: string
    }
  }

  /** Request one testnet drop for `account`. The wallet approval layer may
   *  prompt once per origin session. Resolves with claim details including
   *  before/after balances — the caller should report the delta. */
  async faucetClaim(account: string): Promise<{
    account: string
    amount: string
    balance_before: string
    balance_after: string
    tx_hash: string
  }> {
    this.emit('txPending', { faucet: account })
    const out = (await this.bridge.call('lez_faucetClaim', { account })) as {
      account: string
      amount: string
      balance_before: string
      balance_after: string
      tx_hash: string
    }
    this.emit('txConfirmed', { hash: out.tx_hash })
    return out
  }

  on(event: LezEvent, handler: Handler): void {
    this.bridge.on(event, handler)
  }

  private emit(event: LezEvent, data: unknown) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(`wsp-lez-${event}`, { detail: data }))
    }
  }
}

export default WidespreadLezProvider
