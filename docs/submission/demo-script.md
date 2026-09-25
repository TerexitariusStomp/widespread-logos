# Narrated demo video — script + shot list

Target: ~4 minutes. Record each scene at 1080p; terminal scenes at a large
font (≥18pt) with the CLI output visible. Voiceover reads the italicized
lines; bracketed notes are for the editor.

---

## Scene 1 — What this is (0:00–0:25)

*Widespread is a privacy-preserving wallet for the Logos Execution Zone.
It runs everywhere — browser extension, Logos Basecamp, a desktop app,
even a plain web page — and it keeps every secret on your device. There's
no custodian, no server-side key, and no backdoor recovery.*

[Show the README custody line, then the surfaces diagram from
`packages/wallet-ui/README.md`.]

## Scene 2 — Install and onboard (0:25–1:05)

*Onboarding starts with a sign-in you already know — Google or GitHub —
but the OAuth token never becomes key material. A passkey is created, its
PRF seals the vault key, and a recovery kit is sealed with a passphrase
you choose.*

[Screen-capture `OnboardingFlow` in the extension: provider picker →
passkey prompt → kit download. Cut on the kit file saving.]

## Scene 3 — Real wallet ops on testnet (1:05–1:50)

*This is a real LEZ testnet wallet, not a mock. Creating an account,
claiming testnet funds from the pinata faucet, and sending a transfer —
all through the same worker contract every surface shares.*

[Terminal: `wsp-lez init` → `new-account alice` → `faucet-claim` →
`transfer alice --to <bob> 50` → `balance` polling until it lands. Note
on screen: "block inclusion ~15 s — polling is normal".]

## Scene 4 — The approval gate (1:50–2:30)

*Every spend is gated. When a dApp proposes a program call, the wallet
decodes it against the on-chain registry's IDL — fetched from Logos
Storage — and shows you exactly what it does. Unknown program? You see
the raw bytes and a warning. Connected origins never get silent signing.*

[Drive `apps/testimonial_ui` in a browser: submit → approval sheet shows
decoded `submit(text, username, submission_id)` args → approve → hash.
Then show a second call to an unregistered program rendering raw hex.]

## Scene 5 — The on-chain registry (2:30–3:00)

*The LP-0023 registry is live on testnet. Deployer entries can only be
written by the program itself, through a chained call — a user
transaction trying to register someone else's program as a deployer is
rejected on-chain. Third-party attestations are open, and the client
annotates them with a trusted-signer overlay instead of censoring.*

[Terminal: `lookupDeployerEntry` for each of the three programs → real
entries with storage CIDs. Then the unauthorized `register_deployer`
demo returning no entry.]

## Scene 6 — Recovery, client-side encrypted (3:00–3:40)

*Recovery is yours, not ours. The vault key splits into factors — a
passkey share wrapped and stored on Logos Storage, a device share you
can pair to another machine, and the kit you downloaded. Any two rebuild
the vault. Lose all of them and it's gone forever — by design.*

[Fresh browser profile: recovery flow → passkey prompt → pointer resolve
→ blob restored → accounts and balances reappear.]

## Scene 7 — Where it runs (3:40–4:00)

*Same wallet, every surface: extension, Basecamp module, Tauri desktop,
PWA, CLI — one worker, one UI, no per-platform forks.*

[Quick montage: extension popup → Basecamp hosting the UI module →
Tauri window → PWA in a plain tab (note: read/recovery surface) → CLI.]

*Built for the Logos λPrize. Code, docs, and live testnet artifacts are
in the repo — links below.*

[End card: repo URL + `programs/ARTIFACTS.md` table.]
