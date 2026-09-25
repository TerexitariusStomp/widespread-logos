/**
 * ExtensionBackend — drives the wallet-extension background LEZ ops
 * (background/lez.ts -> wsp-lezd native-messaging helper).
 */

import type { HelperStatus, LezAccount, RegistryEntryLike, WalletBackend } from './backend'

declare const chrome: {
  runtime: {
    sendMessage: (msg: unknown, cb: (resp: unknown) => void) => void
    lastError?: { message?: string }
  }
}

function send<T>(type: string, params?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, params }, (resp) => {
      const r = resp as { error?: string } & Record<string, unknown>
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? 'extension error'))
        return
      }
      if (r?.error) reject(new Error(r.error))
      else resolve(r as T)
    })
  })
}

export class ExtensionBackend implements WalletBackend {
  helperStatus(): Promise<HelperStatus> {
    return send<HelperStatus>('LEZ_HELPER_STATUS')
  }

  async init(password?: string, zone?: string) {
    return send<{ mnemonic: string }>('LEZ_INIT', { password, zone })
  }

  async restore(mnemonic: string, password?: string, zone?: string) {
    await send('LEZ_RESTORE', { mnemonic, password, zone })
  }

  async listAccounts(): Promise<LezAccount[]> {
    const r = await send<{ accounts?: string[] }>('LEZ_ACCOUNTS')
    return (r.accounts ?? []).map((accountId) => ({ label: '', accountId }))
  }

  async createAccount(label: string, isPrivate: boolean) {
    const r = await send<{ accountId: string }>('LEZ_NEW_ACCOUNT', {
      label,
      private: isPrivate,
    })
    return r.accountId
  }

  async balance(account: string) {
    const r = await send<{ result: string }>('LEZ_GET_BALANCE', { account })
    return r.result
  }

  async sync() {
    const r = await send<{ block: number }>('LEZ_SYNC')
    return r.block
  }

  async status() {
    return send<{ sequencer: string }>('LEZ_STATUS')
  }

  async transfer(from: string, to: string, amount: string) {
    const r = await send<{ result: string }>('LEZ_SEND_TRANSACTION', { from, to, amount })
    return r.result
  }

  async programCall(
    program: string,
    instructionDataHex: string,
    accounts: Array<{ account: string; programAccountId: string }>,
    payer?: string,
  ) {
    const r = await send<{ result: string }>('LEZ_PROGRAM_CALL', {
      program,
      instructionDataHex,
      accounts,
      payer,
    })
    return r.result
  }

  async registryLookup(program: string): Promise<RegistryEntryLike | null> {
    const r = await send<{ entry?: RegistryEntryLike | null }>('LEZ_REGISTRY_LOOKUP', {
      program,
    })
    return r.entry ?? null
  }

  async accountRead(account: string) {
    const r = await send<{
      result: { data_b64: string; program_owner: string; balance: string; nonce: number }
    }>('LEZ_ACCOUNT_READ', { account })
    return r.result
  }

  async exportBlob() {
    const r = await send<{ blobB64: string }>('LEZ_EXPORT_BLOB')
    return r.blobB64
  }

  async importBlob(blobB64: string, zone?: string) {
    await send('LEZ_IMPORT_BLOB', { blobB64, zone })
  }
}
