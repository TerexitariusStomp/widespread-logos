# Developer outreach + adoption testimonials

Message drafts and the testimonial-collection path. The on-chain
`testimonial` program is the intended sink for adoption quotes — a
submission is a permanent, attributable attestation, which is stronger
evidence than a screenshot.

## Outreach targets

Where Logos builders actually are:

- Logos Discord/Matrix dev channels
- LEZ repo discussions (`logos-blockchain/logos-execution-zone`)
- SPEL/spel-framework contributors (they'll care about the chained-call
  pattern — PR 3 in `docs/solutions-prs.md`)
- Builders of other λPrize tracks (faucet, modules) — integration asks,
  not just promotion

## Outreach message (Discord/forum DM)

> Hey — we shipped a LEZ wallet that runs as a Basecamp module, browser
> extension, Tauri app, PWA, and CLI off one worker contract. If you're
> building anything that needs key custody or signing on LEZ, the
> `@widespread/lez-provider` SDK gives you connect/transfer/programCall
> with a real approval UX, and the registry lets your program prove its
> own deployer entry on-chain (no registrar needed — see
> `programs/registry/README.md`). Happy to walk you through it or help
> you get a `register_self` hook onto your program.

## Integration asks (concrete, low-friction)

- "Add a `register_self` hook to your SPEL program" — ~40 lines, gives
  your program a self-authenticating registry entry. We have the
  reference implementation + SDK call.
- "Try the provider SDK in your dApp" — `connect()` + `proposeTransaction()`
  with decoded approval sheets.
- "Point your tests at a custom zone" — `wsp-lez --zone <sequencer-url>`
  works against standalone sequencers today.

## Testimonial collection

Ask adopters to submit through `apps/testimonial_ui` (or the SDK's
`submit` call): text ≤2048 chars, a `submission_id` we assign
(`adoption:<github-user>`), username = their handle. The entry lands
on-chain owned by the testimonial program — permanent and attributable.

Template for the ask:

> If Widespread was useful, would you mind submitting a testimonial
> on-chain? It's ~30 seconds: [link to testimonial_ui], submission id
> `adoption:<your-handle>`. It becomes a permanent record tied to your
> account — the strongest possible adoption proof for the submission.

## Testimonial ledger

Track submitted testimonials here (fill in as they land):

| Author | submission_id | Entry PDA | Status |
|---|---|---|---|
| | `adoption:` | | pending |
