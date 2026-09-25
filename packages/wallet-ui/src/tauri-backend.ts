/**
 * TauriBackend — drives `wsp-lezd` (the same native helper the extension
 * uses) through a Tauri sidecar command. The desktop shell spawns the
 * helper, frames worker ops as u32-LE-prefixed JSON on stdio, and persists
 * the sealed vault blob under the app-data dir. Same session flow as
 * ExtensionBackend: unlock with the stored blob, re-persist after writes.
 *
 * Required Tauri commands (see apps/wallet-tauri/src-tauri):
 *   lez_op(op)            -> worker reply JSON
 *   vault_blob_get()      -> string | null  (sealed blob, base64)
 *   vault_blob_set(b64)   -> ()
 */

import type { LezAccount, RegistryEntryLike, WalletBackend } from './backend'

interface TauriCore {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
}

declare global {
  interface Window {
    __TAURI__?: { core?: TauriCore }
  }
}

export function tauriAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.__TAURI__?.core?.invoke
}

function core(): TauriCore {
  const c = window.__TAURI__?.core
  if (!c) throw new Error('Tauri bridge unavailable — not running in the desktop shell')
  return c
}

export class TauriBackend implements WalletBackend {
  private unlocked = false

  private async op<T>(op: Record<string, unknown>): Promise<T> {
    // The Rust command unwraps the helper reply: resolves with `output`,
    // rejects with the helper's error string.
    return await core().invoke<T>('lez_op', { op })
  }

  private async ensureUnlocked(): Promise<void> {
    if (this.unlocked) return
    const blob = await core().invoke<string | null>('vault_blob_get')
    if (!blob) throw new Error('vault locked — init or restore first')
    await this.op({ op: 'unlock', blob_b64: blob })
    this.unlocked = true
  }

  private async persistBlob(): Promise<void> {
    const out = await this.op<{ blob_b64?: string }>({ op: 'export_blob' })
    if (out.blob_b64) await core().invoke('vault_blob_set', { b64: out.blob_b64 })
  }

  async init(password?: string, zone?: string): Promise<{ mnemonic: string }> {
    const out = await this.op<{ mnemonic: string }>({
      op: 'init',
      password: password ?? null,
      zone,
    })
    await this.persistBlob()
    this.unlocked = true
    return out
  }

  async restore(mnemonic: string, password?: string, zone?: string): Promise<void> {
    await this.op({ op: 'restore', mnemonic, password: password ?? null, zone })
    await this.persistBlob()
    this.unlocked = true
  }

  async listAccounts(): Promise<LezAccount[]> {
    await this.ensureUnlocked()
    const out = await this.op<{ accounts?: { account_id: string; label?: string }[] }>({
      op: 'list_accounts',
    })
    return (out.accounts ?? []).map((a) => ({ label: a.label ?? '', accountId: a.account_id }))
  }

  async createAccount(label: string, isPrivate: boolean): Promise<string> {
    await this.ensureUnlocked()
    const out = await this.op<{ account_id?: string }>({
      op: 'create_account',
      label,
      private: isPrivate,
    })
    await this.persistBlob()
    return out.account_id ?? ''
  }

  async balance(account: string): Promise<string> {
    const out = await this.op<{ balance?: number | string }>({ op: 'balance', account })
    return String(out.balance ?? '0')
  }

  async sync(): Promise<number> {
    await this.ensureUnlocked()
    const out = await this.op<{ block?: number }>({ op: 'sync' })
    return out.block ?? 0
  }

  status(): Promise<{ sequencer: string }> {
    return this.op({ op: 'status' })
  }

  async transfer(from: string, to: string, amount: string): Promise<string> {
    await this.ensureUnlocked()
    const out = await this.op<{ hash?: string }>({
      op: 'transfer',
      from,
      to,
      to_private: null,
      amount,
    })
    await this.persistBlob()
    return out.hash ?? ''
  }

  async programCall(
    program: string,
    instructionDataHex: string,
    accounts: Array<{ account: string; programAccountId: string }>,
    payer?: string,
  ): Promise<string> {
    await this.ensureUnlocked()
    const out = await this.op<{ hash?: string }>({
      op: 'program_call',
      program,
      instruction_data_hex: instructionDataHex,
      accounts: accounts.map((a) => ({ account: a.account, program_account_id: a.programAccountId })),
      payer: payer ?? null,
    })
    await this.persistBlob()
    return out.hash ?? ''
  }

  async registryLookup(program: string): Promise<RegistryEntryLike | null> {
    const out = await this.op<{ entry?: RegistryEntryLike | null }>({
      op: 'registry_lookup',
      program,
    })
    return out.entry ?? null
  }

  accountRead(account: string) {
    return this.op<{ data_b64: string; program_owner: string; balance: string; nonce: number }>({
      op: 'account_read',
      account,
    })
  }

  async exportBlob(): Promise<string> {
    await this.ensureUnlocked()
    const out = await this.op<{ blob_b64?: string }>({ op: 'export_blob' })
    return out.blob_b64 ?? ''
  }

  async importBlob(blobB64: string, zone?: string): Promise<void> {
    await core().invoke('vault_blob_set', { b64: blobB64 })
    await this.op({ op: 'unlock', blob_b64: blobB64, zone })
    this.unlocked = true
  }
}
