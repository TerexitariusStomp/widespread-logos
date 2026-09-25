# Social posts — drafts

Draft copy for announcement posts. Trim links/handles per platform
limits; the X/Twitter versions fit 280 chars.

## Launch announcement (X/Twitter)

**Post A (technical):**

> Widespread is live on the LEZ testnet: a privacy-preserving wallet that
> runs in your browser extension, Logos Basecamp, desktop, and CLI — one
> worker contract, zero custodians. Keys never leave the client; recovery
> is passkeys + encrypted Logos Storage. If you lose every factor, it's
> gone forever — by design. #LogosLPrize

**Post B (registry angle):**

> Deployed an on-chain program registry (LP-0023) where deployer entries
> can *only* be written by the program itself — via caller_program_id
> chained calls. No signer games, no trusted registrar. Third-party
> attestations stay open but get a client-side trust badge, never a
> censor list.

**Post C (privacy):**

> OAuth sign-in for onboarding, but the token never touches key material.
> Passkey PRF seals the vault key; shares split across Logos Storage, a
> paired device, and a passphrase kit. Any two rebuild it. This is what
> non-custodial onboarding should look like.

## Logos community / forum post

**Title:** Widespread — a privacy-preserving LEZ wallet across every surface

We built a real wallet for the Logos Execution Zone and wired it into
everywhere a user might already be:

- **Browser extension** — Chromium native messaging into a Rust worker
  (`wsp-lezd`); the sealed vault holds the LEZ blob alongside existing
  wallet state.
- **Logos Basecamp** — a core module + QML UI module in the catalog
  release pipeline (`lgpd`-installable).
- **Desktop** — Tauri shell driving the same daemon as a sidecar.
- **PWA** — a plain web page that does public reads, private-output
  viewing (wasm codecs, viewing keys only), and full vault recovery —
  while honestly refusing to sign.
- **CLI** — `wsp-lez` for scripting and ops.

Plus the supporting programs, all deployed on testnet 0.3:

- **LP-0023 registry** — deployer entries authorized by
  `caller_program_id` chained calls (the only on-chain "I am this
  program" proof possible when deployment is unsigned). Unauthorized
  registration is demonstrably rejected on-chain.
- **Testimonials + pointer** — mini-programs powering the faucet UI and
  the recovery-share locator.
- **Recovery** — client-side-encrypted Logos Storage persistence +
  passkey-PRF/kit/paired-device factors. No custodian; permanent loss
  stays permanent.

Everything a dApp needs: `@widespread/lez-provider` SDK
(connect/transfer/programCall/events) with a per-transaction approval
sheet that decodes calls through the registry's IDL mirror.

Repo, docs, benchmarks (cycle counts per instruction), and deployment
records: [repo link] — feedback welcome, especially on the
chained-call authorization pattern.

## Short variant (Mastodon/Bluesky, ~500 chars)

> A privacy-preserving wallet for Logos Execution Zone, live on testnet:
> extension + Basecamp module + Tauri + PWA + CLI on one worker contract.
> Client-side keys only — recovery via passkeys, kits, and encrypted
> Logos Storage. Plus an on-chain LP-0023 registry where only the program
> itself can claim its own deployer entry. [repo link]
