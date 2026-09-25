/**
 * OnboardingFlow — the shared first-run experience.
 *
 *   New wallet:  [optional social sign-in] → passkey → vault init →
 *                share/blob backup → kit download → (later) pointer publish
 *   Recover:     kit file + passphrase, or a synced passkey
 *   Import:      raw mnemonic (existing seed, no recovery factors)
 *
 * OAuth is strictly optional convenience — the returned identity is only
 * shown to the user and pre-fills the passkey's display name. It is never
 * stored and never touches key material.
 */

import React, { useState } from 'react'
import { RestStorageClient, passkeyPrfSupported } from '@widespread/recovery'
import type { StorageClient } from '@widespread/recovery'
import type { WalletBackend } from './backend'
import {
  createWalletWithRecovery,
  recoverWalletWithKit,
  recoverWalletWithPasskey,
  LocalSecretStore,
  pointerKey,
} from './onboarding'
import type { SecretStore, SocialIdentity, SocialSignInHook } from './onboarding'

export interface OnboardingProps {
  backend: WalletBackend
  /** Testnet-0.3 pointer program id (see programs/ARTIFACTS.md). */
  pointerProgramId: string
  /** Storage node base URL for share/blob uploads. */
  storageNode?: string
  /** Host OAuth ceremony — when absent, social sign-in is not offered. */
  socialSignIn?: SocialSignInHook
  /** Host secret store — defaults to localStorage. */
  secrets?: SecretStore
  /** Injected storage client (tests / alternate transports). */
  storage?: StorageClient
  onDone(): void
}

type Step =
  | { kind: 'choose' }
  | { kind: 'create' }
  | { kind: 'import' }
  | { kind: 'recover' }
  | { kind: 'busy'; label: string }
  | { kind: 'done'; mnemonic?: string; kitUrl?: string }

export function OnboardingFlow(props: OnboardingProps) {
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const secrets = props.secrets ?? new LocalSecretStore()
  const storage =
    props.storage ?? new RestStorageClient(props.storageNode ?? 'http://localhost:8080')

  const fail = (e: unknown) => {
    setStep({ kind: 'choose' })
    setError(e instanceof Error ? e.message : String(e))
  }

  return (
    <div className="wsp-onboarding">
      <h2>Widespread wallet</h2>
      {error && <p className="wsp-error" role="alert">{error}</p>}
      {notice && <p className="wsp-notice">{notice}</p>}

      {step.kind === 'choose' && (
        <section>
          <button onClick={() => setStep({ kind: 'create' })}>Create a new wallet</button>
          <button onClick={() => setStep({ kind: 'recover' })}>Recover a wallet</button>
          <button onClick={() => setStep({ kind: 'import' })}>Import a mnemonic</button>
        </section>
      )}

      {step.kind === 'create' && (
        <CreateStep
          {...props}
          storage={storage}
          secrets={secrets}
          busy={(label) => setStep({ kind: 'busy', label })}
          done={(mnemonic, kitUrl) => setStep({ kind: 'done', mnemonic, kitUrl })}
          onNotice={setNotice}
          onError={fail}
          back={() => setStep({ kind: 'choose' })}
        />
      )}

      {step.kind === 'recover' && (
        <RecoverStep
          {...props}
          storage={storage}
          secrets={secrets}
          busy={(label) => setStep({ kind: 'busy', label })}
          done={() => setStep({ kind: 'done' })}
          onError={fail}
          back={() => setStep({ kind: 'choose' })}
        />
      )}

      {step.kind === 'import' && (
        <ImportStep
          {...props}
          busy={(label) => setStep({ kind: 'busy', label })}
          done={() => setStep({ kind: 'done' })}
          onError={fail}
          back={() => setStep({ kind: 'choose' })}
        />
      )}

      {step.kind === 'busy' && <p>{step.label}</p>}

      {step.kind === 'done' && (
        <section>
          <h3>Wallet ready</h3>
          {step.mnemonic && (
            <>
              <p>Write down your recovery phrase — it is shown once:</p>
              <pre className="wsp-mnemonic">{step.mnemonic}</pre>
            </>
          )}
          {step.kitUrl && (
            <p>
              <a href={step.kitUrl} download="widespread-recovery-kit.wspk">
                Download your recovery kit
              </a>{' '}
              — store it somewhere only you control. It is one of your
              recovery factors; losing every factor makes the wallet
              permanently unrecoverable.
            </p>
          )}
          <button onClick={props.onDone}>Continue to wallet</button>
        </section>
      )}
    </div>
  )
}

function CreateStep({
  backend,
  pointerProgramId,
  socialSignIn,
  storage,
  secrets,
  busy,
  done,
  onNotice,
  onError,
  back,
}: OnboardingProps & {
  storage: StorageClient
  secrets: SecretStore
  busy(l: string): void
  done(mnemonic: string, kitUrl: string): void
  onNotice(n: string): void
  onError(e: unknown): void
  back(): void
}) {
  const [identity, setIdentity] = useState<SocialIdentity | null>(null)
  const [userName, setUserName] = useState('')
  const [kitPassphrase, setKitPassphrase] = useState('')


  const run = async () => {
    if (!passkeyPrfSupported()) {
      onError(new Error('this context cannot create PRF passkeys — import a mnemonic instead'))
      return
    }
    busy('Creating passkey…')
    try {
      const name = identity?.displayName ?? identity?.subject ?? userName
      const res = await createWalletWithRecovery({
        backend,
        storage,
        secrets,
        userName: name || 'widespread-user',
        kitPassphrase: kitPassphrase || 'wsp-kit',
      })
      busy('Preparing your recovery kit…')
      const blob = new Blob([res.kitBytes.slice().buffer as ArrayBuffer], {
        type: 'application/octet-stream',
      })
      const url = URL.createObjectURL(blob)
      onNotice(
        `Backup published — ptr ${pointerKey(res.ptr)} → ${res.pointerValue}. ` +
          'Publish the pointer on-chain once an account is funded (Accounts → faucet).',
      )
      done(res.mnemonic, url)
    } catch (e) {
      onError(e)
    }
  }

  return (
    <section>
      <h3>New wallet</h3>
      {socialSignIn && (
        <div className="wsp-social">
          <p>Sign in for convenience — optional; never becomes wallet key material:</p>
          <button
            onClick={() =>
              socialSignIn('google').then(setIdentity).catch((e) => onError(e))
            }
          >
            Continue with Google
          </button>
          <button
            onClick={() =>
              socialSignIn('github').then(setIdentity).catch((e) => onError(e))
            }
          >
            Continue with GitHub
          </button>
          {identity && (
            <p className="wsp-notice">
              signed in as {identity.displayName ?? identity.subject ?? identity.provider}
            </p>
          )}
        </div>
      )}
      <input
        value={userName}
        onChange={(e) => setUserName(e.target.value)}
        placeholder="display name (for the passkey)"
      />
      <input
        type="password"
        value={kitPassphrase}
        onChange={(e) => setKitPassphrase(e.target.value)}
        placeholder="kit passphrase (protects your recovery kit file)"
      />
      <button onClick={() => void run()}>Create passkey + wallet</button>
      <button onClick={back}>Back</button>
    </section>
  )
}

function RecoverStep({
  backend,
  pointerProgramId,
  storage,
  secrets,
  busy,
  done,
  onError,
  back,
}: OnboardingProps & {
  storage: StorageClient
  secrets: SecretStore
  busy(l: string): void
  done(): void
  onError(e: unknown): void
  back(): void
}) {
  const [kitFile, setKitFile] = useState<Uint8Array | null>(null)
  const [kitPassphrase, setKitPassphrase] = useState('')

  return (
    <section>
      <h3>Recover wallet</h3>
      <label>
        Recovery kit file:
        <input
          type="file"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void f.arrayBuffer().then((b) => setKitFile(new Uint8Array(b)))
          }}
        />
      </label>
      <input
        type="password"
        value={kitPassphrase}
        onChange={(e) => setKitPassphrase(e.target.value)}
        placeholder="kit passphrase"
      />
      <button
        disabled={!kitFile}
        onClick={() => {
          busy('Opening kit…')
          recoverWalletWithKit({
            backend,
            storage,
            secrets,
            pointerProgramId,
            kitBytes: kitFile!,
            kitPassphrase,
          })
            .then(done)
            .catch(onError)
        }}
      >
        Recover from kit
      </button>
      <button
        onClick={() => {
          busy('Asking passkey…')
          recoverWalletWithPasskey({ backend, storage, secrets, pointerProgramId })
            .then(done)
            .catch(onError)
        }}
      >
        Recover with passkey
      </button>
      <p>
        Passkey recovery needs a second factor — the published pointer plus this
        device&apos;s share, or a paired device. A passkey alone is never enough:
        that&apos;s the design.
      </p>
      <button onClick={back}>Back</button>
    </section>
  )
}

function ImportStep({
  backend,
  busy,
  done,
  onError,
  back,
}: OnboardingProps & {
  busy(l: string): void
  done(): void
  onError(e: unknown): void
  back(): void
}) {
  const [mnemonic, setMnemonic] = useState('')
  return (
    <section>
      <h3>Import mnemonic</h3>
      <textarea
        value={mnemonic}
        onChange={(e) => setMnemonic(e.target.value)}
        placeholder="12 or 24 words"
      />
      <button
        onClick={() => {
          busy('Restoring vault…')
          backend
            .restore(mnemonic.trim())
            .then(done)
            .catch(onError)
        }}
      >
        Import
      </button>
      <button onClick={back}>Back</button>
    </section>
  )
}
