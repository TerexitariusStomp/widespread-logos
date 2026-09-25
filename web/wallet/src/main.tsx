/**
 * Shared wallet-ui entry: pick the backend for the host surface and mount.
 *
 *   Basecamp WebView    — ModuleBackend (logos.callModuleAsync bridge
 *   injected by WalletView.qml)
 *   Tauri desktop shell — TauriBackend (wsp-lezd sidecar via __TAURI__)
 *   Extension popup     — ExtensionBackend (chrome.runtime messages)
 *   Plain web / PWA     — PwaBackend (direct sequencer reads + client-side
 *   wasm viewing; signing surfaces unavailable)
 *
 * First run shows OnboardingFlow (passkey + recovery-kit setup); once the
 * vault has accounts the main WalletApp mounts.
 */

import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ExtensionBackend,
  ModuleBackend,
  OnboardingFlow,
  PwaBackend,
  TauriBackend,
  WalletApp,
  moduleAvailable,
  tauriAvailable,
} from '@widespread/wallet-ui'

// Testnet-0.3 pointer program (programs/ARTIFACTS.md) — publishes
// ptr → "shareCid:blobCid" records for passkey/device recovery.
const POINTER_PROGRAM_ID =
  'a97a787dee00aaf8541e473f96474ef5f5342ca6f4d9883d8554b8b1ced0a5bd'

const extensionRuntime = (
  globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }
).chrome?.runtime?.sendMessage

const backend = moduleAvailable()
  ? new ModuleBackend()
  : tauriAvailable()
    ? new TauriBackend()
    : typeof extensionRuntime === 'function'
      ? new ExtensionBackend()
      : new PwaBackend({
          registryProgram:
            'be6cd0c3c15e6d6236cadf3af0eb63332473f223c0713256f7a5b83e0fac2cf5',
          wasmUrl: new URL('./wsp_lez_wasm_bg.wasm', import.meta.url).href,
        })

function Root() {
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null)

  useEffect(() => {
    backend
      .listAccounts()
      .then((accts) => setNeedsOnboarding(accts.length === 0))
      .catch(() => setNeedsOnboarding(true)) // no vault → onboarding
  }, [])

  if (needsOnboarding === null) return null
  if (needsOnboarding) {
    return React.createElement(OnboardingFlow, {
      backend,
      pointerProgramId: POINTER_PROGRAM_ID,
      onDone: () => setNeedsOnboarding(false),
    })
  }
  return React.createElement(WalletApp, { backend })
}

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(React.createElement(Root))
}
