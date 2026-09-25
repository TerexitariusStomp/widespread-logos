# @widespread/wallet-ui

Shared wallet UI + backend abstraction — one codebase hosting the wallet
on every surface. The same `WalletApp` component and `WalletBackend`
contract run in the browser extension, the Logos module/Basecamp WebView,
the PWA, and the Tauri desktop shell.

## Architecture

```
                 ┌────────────────────────────────────┐
   WalletApp ─── │  WalletBackend (execute-op style)  │
   (React UI)    └───────────────┬────────────────────┘
                                 │
      ┌──────────┬───────────────┼──────────────┬───────────────┐
 ExtensionBackend  ModuleBackend  PwaBackend   TauriBackend
 (native msg via    (logos.        (indexer     (sidecar framed
  wsp-lezd)         callModule)     reads only)  stdio→wsp-lezd)
```

Every backend talks to the same `wsp-lez-core` worker contract
(`execute(op, blob) -> (result, blob')`) — wallet logic lives in one
place and surfaces never reimplement it.

## Backends

| Backend | Surface | Signing |
|---|---|---|
| `ExtensionBackend` | Browser extension (Chromium native messaging → `wsp-lezd`) | full |
| `ModuleBackend` | Logos Core module / Basecamp WebView | full |
| `TauriBackend` | Tauri desktop shell (`lez_op` command → `wsp-lezd` sidecar) | full |
| `PwaBackend` | Pure browser (PWA) | **reads + recovery only** — signing throws `UnsupportedSurfaceError` |

The PWA surface is honest about its boundary: public reads go to the LEZ
indexer, registry lookups to `@widespread/lez-registry`, and recovery via
`importBlob`/`accountRead` works — but no signing op is ever pretended to
exist.

## Approval gate

`GatedBackend` wraps any `WalletBackend` and interposes a confirm hook on
signing ops (`transfer`, `programCall`):

```ts
const backend = new GatedBackend(inner, {
  confirm: async (effect) => showApprovalSheet(effect),
})
```

Program calls are decoded through the risc0-serde instruction format and
the program's IDL (fetched by `idl_cid` from the on-chain LP-0023
registry, with graceful fallback to raw hex when the mirror is down), so
the approval sheet shows a human-readable effect — not opaque bytes.
Sessions are scope-keyed (`program_call:<program>`) and the phishing
guard warns when a call's declared accounts don't match the registry.

## Onboarding

`OnboardingFlow` + `onboardVault` (from `@widespread/recovery`) implement
social-sign-in onboarding: OAuth identity (popup helpers in `social.ts`)
→ passkey creation with PRF → vault sealing → kit export. OAuth tokens
identify the user but never become wallet key material.

## Building

`scripts/build-ui.sh` bundles `web/wallet` into `dist/` (`bundle.js` +
`wsp_lez_wasm_bg.wasm` + manifest + service worker + icons). The same
bundle is embedded by the Logos UI module and served as the PWA.
