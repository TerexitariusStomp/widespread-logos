/**
 * ModuleBackend — drives the widespread_wallet LogosCore module through the
 * Basecamp/WebView bridge (`window.logos.callModuleAsync`), the same path
 * logos-webview-app demonstrates.
 *
 * The module's `execute` op is the identical wire contract as wsp-lezd:
 * `op` is the serialized Op, the result is the serialized Output envelope.
 */

import type { LezAccount, RegistryEntryLike, WalletBackend } from './backend'

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

const MODULE = 'widespread_wallet'

export function moduleAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.logos?.callModuleAsync
}

async function callModule(module: string, method: string, args: unknown[]): Promise<string> {
  if (!window.logos?.callModuleAsync) {
    throw new Error('logos module bridge not available')
  }
  return new Promise((resolve, reject) => {
    try {
      window.logos!.callModuleAsync(module, method, args, (result) => resolve(result))
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/** Run one worker op on the module and decode the Output envelope. */
async function exec<T>(op: Record<string, unknown>): Promise<T> {
  const raw = await callModule(MODULE, 'execute', [JSON.stringify(op)])
  const out = JSON.parse(raw) as { type?: string; message?: string } & T
  if (out.type === 'error') throw new Error(out.message ?? 'module error')
  return out
}

export class ModuleBackend implements WalletBackend {
  async init(password?: string, zone?: string) {
    const out = await exec<{ mnemonic: string; blob_b64: string }>({
      op: 'init',
      password: password ?? null,
      zone: zone ?? null,
    })
    return { mnemonic: out.mnemonic }
  }

  async restore(mnemonic: string, password?: string, zone?: string) {
    await exec({ op: 'restore', mnemonic, password: password ?? null, zone: zone ?? null })
  }

  async listAccounts(): Promise<LezAccount[]> {
    const out = await exec<{ accounts: LezAccount[] }>({ op: 'list_accounts' })
    return out.accounts ?? []
  }

  async createAccount(label: string, isPrivate: boolean) {
    const out = await exec<{ account_id: string }>({
      op: 'create_account',
      label,
      private: isPrivate,
    })
    return out.account_id
  }

  async balance(account: string) {
    const out = await exec<{ balance: number | string }>({ op: 'balance', account })
    return String(out.balance)
  }

  async sync() {
    const out = await exec<{ block: number }>({ op: 'sync' })
    return out.block
  }

  async status() {
    const out = await exec<{ sequencer: string }>({ op: 'status' })
    return { sequencer: out.sequencer }
  }

  async transfer(from: string, to: string, amount: string) {
    const out = await exec<{ hash: string }>({
      op: 'transfer',
      from,
      to,
      amount,
    })
    return out.hash
  }

  async programCall(
    program: string,
    instructionDataHex: string,
    accounts: Array<{ account: string; programAccountId: string }>,
    payer?: string,
  ) {
    const out = await exec<{ hash: string }>({
      op: 'program_call',
      program,
      instruction_data_hex: instructionDataHex,
      accounts,
      payer: payer ?? null,
    })
    return out.hash
  }

  /** Faucet claim via the upstream lez_faucet module (Piñata claim). */
  async faucetDrop(account: string, requestKey: string) {
    const raw = await callModule('lez_faucet', 'requestDrop', [account, requestKey])
    return JSON.parse(raw)
  }

  callModule(module: string, method: string, args: unknown[]) {
    return callModule(module, method, args)
  }

  async registryLookup(program: string): Promise<RegistryEntryLike | null> {
    const out = await exec<{ entry: RegistryEntryLike | null }>({
      op: 'registry_lookup',
      program,
    })
    return out.entry
  }

  async accountRead(account: string) {
    return exec<{ data_b64: string; program_owner: string; balance: string; nonce: number }>({
      op: 'account_read',
      account,
    })
  }

  async exportBlob() {
    const out = await exec<{ blob_b64: string }>({ op: 'export_blob' })
    return out.blob_b64
  }

  async importBlob(blobB64: string, zone?: string) {
    await exec({ op: 'unlock', blob_b64: blobB64, zone: zone ?? null })
  }
}
