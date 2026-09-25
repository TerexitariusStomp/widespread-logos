/**
 * Shared LEZ wallet UI — the same tree renders in the extension popup, the
 * Basecamp WebView module, and the Tauri shell; only the WalletBackend
 * differs. Plain components, no UI-framework lock-in (the Logos design
 * system's CSS applies on Basecamp surfaces).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { LezAccount, WalletBackend } from './backend'
import { GatedBackend } from './approval'
import type { CallEffect } from './approval'
import { bytesToHex, computePublicPda } from './pda'

type Tab = 'accounts' | 'send' | 'faucet' | 'testimonial' | 'status'

export function WalletApp({
  backend: rawBackend,
  storageNode,
}: {
  backend: WalletBackend
  /** Codex/Logos Storage node used to fetch program IDLs for call decoding. */
  storageNode?: string
}) {
  const [tab, setTab] = useState<Tab>('accounts')
  const [accounts, setAccounts] = useState<LezAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<{
    effect: CallEffect
    resolve: (ok: boolean) => void
  } | null>(null)

  // Every wallet-initiated spend/call passes the approval gate — the
  // confirm hook suspends the op until the modal resolves.
  const backend = useMemo(
    () =>
      new GatedBackend(rawBackend, {
        confirm: (effect) => new Promise<boolean>((resolve) => setPending({ effect, resolve })),
        storageNode,
      }),
    [rawBackend, storageNode],
  )

  const refresh = useCallback(async () => {
    try {
      setAccounts(await backend.listAccounts())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [backend])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = (fn: () => Promise<string>) => {
    setError(null)
    setNotice(null)
    fn()
      .then(setNotice)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => void refresh())
  }

  return (
    <div className="wsp-wallet">
      <nav className="wsp-tabs">
        {(['accounts', 'send', 'faucet', 'testimonial', 'status'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {error && <p className="wsp-error" role="alert">{error}</p>}
      {notice && <p className="wsp-notice">{notice}</p>}
      {tab === 'accounts' && <AccountsView backend={backend} accounts={accounts} run={run} />}
      {tab === 'send' && <SendView backend={backend} accounts={accounts} run={run} />}
      {tab === 'faucet' && <FaucetView backend={backend} accounts={accounts} run={run} />}
      {tab === 'testimonial' && (
        <TestimonialView backend={backend} accounts={accounts} run={run} />
      )}
      {tab === 'status' && <StatusView backend={backend} />}
      {pending && (
        <div className="wsp-approval-overlay" role="dialog" aria-modal="true">
          <div className="wsp-approval">
            <h3>Approve {pending.effect.kind === 'transfer' ? 'transfer' : 'program call'}?</h3>
            <pre>{pending.effect.summary}</pre>
            {pending.effect.program && (
              <p className="wsp-verified">
                verified: {pending.effect.program.name} v{pending.effect.program.version}
              </p>
            )}
            {pending.effect.warnings.map((w) => (
              <p key={w} className="wsp-warning" role="alert">
                {w}
              </p>
            ))}
            <div className="wsp-approval-buttons">
              <button
                onClick={() => {
                  pending.resolve(true)
                  setPending(null)
                }}
              >
                Approve
              </button>
              <button
                onClick={() => {
                  pending.resolve(false)
                  setPending(null)
                }}
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AccountsView({
  backend,
  accounts,
  run,
}: {
  backend: WalletBackend
  accounts: LezAccount[]
  run: (fn: () => Promise<string>) => void
}) {
  const [label, setLabel] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [balances, setBalances] = useState<Record<string, string>>({})

  useEffect(() => {
    for (const a of accounts) {
      backend
        .balance(a.accountId)
        .then((b) => setBalances((prev) => ({ ...prev, [a.accountId]: b })))
        .catch(() => {})
    }
  }, [accounts, backend])

  return (
    <section>
      <h2>Accounts</h2>
      <ul>
        {accounts.map((a) => (
          <li key={a.accountId}>
            <code>{a.accountId}</code> {a.label && <em>({a.label})</em>}
            {balances[a.accountId] !== undefined && <strong> — {balances[a.accountId]}</strong>}
          </li>
        ))}
        {accounts.length === 0 && <li>No accounts yet.</li>}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!label.trim()) return
          run(async () => `created ${await backend.createAccount(label.trim(), isPrivate)}`)
          setLabel('')
        }}
      >
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="account label"
        />
        <label>
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
          />
          private
        </label>
        <button type="submit">Create</button>
      </form>
    </section>
  )
}

function SendView({
  backend,
  accounts,
  run,
}: {
  backend: WalletBackend
  accounts: LezAccount[]
  run: (fn: () => Promise<string>) => void
}) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const publicAccounts = accounts.filter((a) => !a.accountId.startsWith('Private/'))

  return (
    <section>
      <h2>Send</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          run(async () => `tx ${await backend.transfer(from, to, amount)}`)
        }}
      >
        <select value={from} onChange={(e) => setFrom(e.target.value)} required>
          <option value="">from account…</option>
          {publicAccounts.map((a) => (
            <option key={a.accountId} value={a.accountId}>
              {a.label || a.accountId}
            </option>
          ))}
        </select>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Public/<account id>"
          required
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="amount"
          inputMode="numeric"
          required
        />
        <button type="submit">Send</button>
      </form>
    </section>
  )
}

function FaucetView({
  backend,
  accounts,
  run,
}: {
  backend: WalletBackend
  accounts: LezAccount[]
  run: (fn: () => Promise<string>) => void
}) {
  const [account, setAccount] = useState('')
  const publicAccounts = accounts.filter((a) => a.accountId.startsWith('Public/'))

  return (
    <section>
      <h2>Testnet faucet</h2>
      <p>Request one testnet drop for a public account. Rate limits apply.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!backend.faucetDrop) {
            setAccount('')
            return
          }
          const key =
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random()}`
          run(async () => {
            const res = await backend.faucetDrop!(account, key)
            return `faucet: ${JSON.stringify(res)}`
          })
        }}
      >
        <select value={account} onChange={(e) => setAccount(e.target.value)} required>
          <option value="">account…</option>
          {publicAccounts.map((a) => (
            <option key={a.accountId} value={a.accountId}>
              {a.label || a.accountId}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!backend.faucetDrop}>
          Request drop
        </button>
      </form>
      {!backend.faucetDrop && (
        <p>Faucet claims run through the lez_faucet module — available on Logos surfaces.</p>
      )}
    </section>
  )
}

function TestimonialView({
  backend,
  accounts,
  run,
}: {
  backend: WalletBackend
  accounts: LezAccount[]
  run: (fn: () => Promise<string>) => void
}) {
  const [from, setFrom] = useState('')
  const [text, setText] = useState('')
  const [username, setUsername] = useState('')

  // The testimonial program's submit instruction: accounts [entry_pda, author],
  // args (text, username, submission_id) borsh-encoded. Encoding happens in
  // the instruction builder — the PDA and wire bytes are produced by
  // `buildTestimonialCall` once the deployed program id is configured.
  // The testnet-0.3 testimonial deployment (programs/ARTIFACTS.md).
  const [programId, setProgramId] = useState(
    '9aa87b6ba0a722bb79fec3e2dc0ee58fd303c1127d13699fff27e6d7627fb9f4',
  )

  return (
    <section>
      <h2>Leave a testimonial</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          run(async () => {
            const { program, instructionDataHex, accounts: mentions } =
              await buildTestimonialCall(programId, from, text, username)
            return `tx ${await backend.programCall(program, instructionDataHex, mentions, from)}`
          })
        }}
      >
        <input
          value={programId}
          onChange={(e) => setProgramId(e.target.value)}
          placeholder="testimonial program id (64-hex image id)"
          required
        />
        <select value={from} onChange={(e) => setFrom(e.target.value)} required>
          <option value="">signing account…</option>
          {accounts.map((a) => (
            <option key={a.accountId} value={a.accountId}>
              {a.label || a.accountId}
            </option>
          ))}
        </select>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username (optional)"
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="what do you think of Widespread?"
          required
        />
        <button type="submit">Submit on-chain</button>
      </form>
    </section>
  )
}

function StatusView({ backend }: { backend: WalletBackend }) {
  const [status, setStatus] = useState<string>('loading…')
  const [helper, setHelper] = useState<string | null>(null)

  useEffect(() => {
    backend
      .status()
      .then((s) => setStatus(JSON.stringify(s, null, 2)))
      .catch((e) => setStatus(e instanceof Error ? e.message : String(e)))
    backend
      .helperStatus?.()
      .then((h) => setHelper(`${h.state}${h.detail ? ` — ${h.detail}` : ''}`))
      .catch(() => {})
  }, [backend])

  return (
    <section>
      <h2>Status</h2>
      {helper !== null && <p>helper: {helper}</p>}
      <pre>{status}</pre>
      <button onClick={() => void backend.sync().then(() => undefined)}>Sync now</button>
    </section>
  )
}

/**
 * Build the testimonial program call, matching the on-chain contract:
 *
 *   submit(text: String, username: String, submission_id: String)
 *
 * Instruction wire format is risc0-serde (`risc0_zkvm::serde::to_vec`):
 * a u32-word stream — variant index u32, then per String a u32 byte
 * length followed by the utf8 bytes packed little-endian into words and
 * zero-padded to the next word boundary. The entry PDA is
 * `["testimonial", submission_id]` — derived off-chain exactly as the
 * SPEL pda macro does (see pda.ts). `submission_id` must fit a 32-byte
 * seed, so it is 16 random bytes as hex.
 *
 * Mentions: [entry_pda, author] — both selecting the testimonial
 * program's shard, in the handler's account order.
 */
async function buildTestimonialCall(
  programId: string,
  author: string,
  text: string,
  username: string,
): Promise<{
  program: string
  instructionDataHex: string
  accounts: Array<{ account: string; programAccountId: string }>
}> {
  const submissionId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const entryPda = await computePublicPda(programId, ['testimonial', submissionId])
  const enc = new TextEncoder()
  const words: number[] = [0] // variant index 0 = submit (u32 word)
  for (const s of [text, username, submissionId]) {
    const b = enc.encode(s)
    words.push(b.length)
    for (let i = 0; i < b.length; i += 4) {
      words.push(
        (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24),
      )
    }
  }
  const instructionDataHex = words
    .flatMap((w) => [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, (w >> 24) & 0xff])
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
  return {
    program: programId,
    instructionDataHex,
    accounts: [
      { account: `Public/${entryPda}`, programAccountId: programId },
      { account: author, programAccountId: programId },
    ],
  }
}
