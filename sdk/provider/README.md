# @widespread/lez-provider

dApp-facing LEZ wallet provider SDK (LP-0021). The API surface every
Widespread host exposes to web apps — connect, read balances, propose
transfers and program calls, subscribe to account/tx events.

## Transports

The SDK picks whichever transport the host provides, in order:

1. `window.lez` — injected by the Widespread browser extension's in-page
   provider (also the standard discovery mechanism).
2. The `ROOTED_WALLET_REQUEST`/`ROOTED_WALLET_RESPONSE` window-event
   bridge relayed by the extension's content script.
3. The Logos module bridge (`logos.callModuleAsync`) inside Basecamp
   WebView and other Logos module hosts.

The same calls work on every surface; the wallet decides which operations
are supported (e.g. the pure-browser PWA surface accepts reads/recovery
but rejects signing).

## Usage

```ts
import { WidespreadLezProvider } from '@widespread/lez-provider'

const lez = new WidespreadLezProvider()

// Connect — the wallet shows an approval prompt; the returned accounts
// are the ones the user approved for this origin.
const accounts = await lez.connect({ name: 'My dApp', url: location.origin })

const balance = await lez.getBalance(accounts[0])

// Public transfer (amount in the chain's base units).
const txHash = await lez.transfer({ from: accounts[0], to: 'acct…', amount: '50' })

// Program call — always gated by the wallet's approval sheet, which shows
// the IDL-decoded effect when the program is listed in the on-chain
// registry (LP-0023).
const callHash = await lez.proposeTransaction({
  program: '<program id>',
  instructionDataHex: '…',
  accounts: [{ account: '<acct>', programAccountId: '<pid>' }],
})

// Events
lez.on('accountsChanged', (accts) => { /* re-render */ })
lez.on('txPending', (hash) => { /* submitted */ })
lez.on('txConfirmed', (hash) => { /* included */ })
```

Faucet helpers (`faucetInfo`, `faucetClaim`) are exposed for testnet
onboarding and are subject to the same per-origin approval rules.

## Security model

- **Connection scoping**: `connect` is origin-scoped; each origin sees
  only the accounts the user approved.
- **Per-transaction approval**: `transfer` and `proposeTransaction` always
  prompt — connected status never implies signing authority.
- **Key isolation**: signing happens inside the native wallet process
  (`wsp-lezd`) / Logos module; the dApp never sees key material.
- Private balances and private-output viewing keys are never exposed to
  page origins.
