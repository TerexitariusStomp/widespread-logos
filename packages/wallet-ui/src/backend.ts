/**
 * WalletBackend — the seam that lets one UI run on every surface.
 *
 * Implementations:
 *   ExtensionBackend  — chrome.runtime messages -> background LEZ ops -> wsp-lezd
 *   ModuleBackend     — window.logos.callModuleAsync -> widespread_wallet module
 *
 * Account ids use the upstream `Public/<hex>` / `Private/<hex>` form.
 */

export interface LezAccount {
  label: string
  accountId: string
}

/** Deployer entry from the on-chain LP-0023 registry (worker `registry_lookup`). */
export interface RegistryEntryLike {
  name: string
  version: string
  idl_cid: string
  kind: string
}

export interface HelperStatus {
  state: 'connected' | 'helper_missing' | 'error'
  detail?: string
}

export interface WalletBackend {
  /** Extension surfaces only: whether the native helper is reachable. */
  helperStatus?(): Promise<HelperStatus>

  /** Create a fresh vault (returns the mnemonic once).
   *  `zone` is the LP-0022 selector ('lez' default, or a sequencer URL). */
  init(password?: string, zone?: string): Promise<{ mnemonic: string }>
  /** Restore a vault from a mnemonic. */
  restore(mnemonic: string, password?: string, zone?: string): Promise<void>

  listAccounts(): Promise<LezAccount[]>
  createAccount(label: string, isPrivate: boolean): Promise<string>
  balance(account: string): Promise<string>
  sync(): Promise<number>
  status(): Promise<{ sequencer: string; zone?: string }>

  transfer(from: string, to: string, amount: string): Promise<string>
  programCall(
    program: string,
    instructionDataHex: string,
    accounts: Array<{ account: string; programAccountId: string }>,
    payer?: string,
  ): Promise<string>

  /** Request a testnet drop for `account` via the lez_faucet module.
   *  Only available on module surfaces; extension surfaces shell out to the
   *  faucet's own UI module if present. */
  faucetDrop?(account: string, requestKey: string): Promise<unknown>

  /** Call another Logos module (faucet, registry SDK helpers…).
   *  Module surfaces only. */
  callModule?(module: string, method: string, args: unknown[]): Promise<string>

  /** Look up a program's deployer entry in the on-chain registry.
   *  Returns null when absent or unresolvable. */
  registryLookup?(program: string): Promise<RegistryEntryLike | null>

  /** Generic public-account read — raw data for PDAs (pointer records…). */
  accountRead?(account: string): Promise<{
    data_b64: string
    program_owner: string
    balance: string
    nonce: number
  }>

  /** Serialize the session vault blob out (for encrypted backup). */
  exportBlob?(): Promise<string>
  /** Import a previously exported blob (recovery path). */
  importBlob?(blobB64: string, zone?: string): Promise<void>
}
