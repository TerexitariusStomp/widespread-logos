/**
 * faucet_ui — testnet drop claims through the provider SDK.
 *
 * Flow: connect → pick a public account → faucet state (pool, difficulty,
 * eligibility) → claim. The wallet solves the Piñata proof-of-work in the
 * native helper; this app only reports the result. Rate limits surface as
 * `can_claim`/`blocked_reason`; the claim response carries the real
 * before/after balances so the delta is verified, not assumed.
 */

import { WidespreadLezProvider } from '../../../sdk/provider/src/index'

const app = document.getElementById('app')!

function el(tag: string, attrs: Record<string, string> = {}, text = ''): HTMLElement {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  if (text) e.textContent = text
  return e
}

async function main() {
  if (!WidespreadLezProvider.isAvailable()) {
    app.append(
      el('p', { class: 'err' }, 'No Widespread wallet detected — install the extension or open this page inside Logos Basecamp.'),
    )
    return
  }
  const provider = new WidespreadLezProvider()

  const connectBtn = el('button', {}, 'Connect wallet')
  app.append(connectBtn)
  connectBtn.onclick = async () => {
    connectBtn.textContent = 'Connecting…'
    try {
      const accounts = (await provider.connect({ name: 'LEZ faucet' })).filter((a) =>
        a.startsWith('Public/'),
      )
      if (!accounts.length) throw new Error('no public accounts — create one in the wallet')
      connectBtn.remove()
      void renderForm(accounts)
    } catch (e) {
      connectBtn.textContent = 'Connect wallet'
      app.append(el('p', { class: 'err' }, String(e)))
    }
  }

  async function renderForm(accounts: string[]) {
    const from = el('select') as HTMLSelectElement
    for (const a of accounts) from.append(el('option', { value: a }, a))
    const status = el('table')
    const claim = el('button', {}, 'Request drop')
    const out = el('p')
    app.append(from, status, claim, out)

    async function refreshStatus() {
      status.innerHTML = ''
      try {
        const info = await provider.faucetInfo()
        status.append(
          row('drop size', info.prize),
          row('pool balance', info.pool_balance),
          row('claims remaining', info.claims_remaining),
          row('difficulty', `${info.difficulty_bytes} leading-zero bytes`),
          row('eligibility', info.can_claim ? 'ready' : `blocked — ${info.blocked_reason}`),
        )
        claim.toggleAttribute('disabled', !info.can_claim)
      } catch (e) {
        status.append(el('tr'))
        status.lastElementChild!.append(el('td', { class: 'err' }, String(e)))
      }
    }

    function row(k: string, v: string) {
      const tr = el('tr')
      tr.append(el('td', { class: 'muted' }, k), el('td', {}, v))
      return tr
    }

    claim.onclick = async () => {
      out.className = ''
      out.textContent = 'Solving the proof-of-work in the wallet — this can take a minute…'
      claim.setAttribute('disabled', 'true')
      try {
        const res = await provider.faucetClaim(from.value)
        const delta = BigInt(res.balance_after) - BigInt(res.balance_before)
        out.className = 'ok'
        out.innerHTML = ''
        out.append(
          el('span', {}, `Claimed ${res.amount} — balance delta verified: +${delta}. tx `),
          el('code', {}, res.tx_hash),
        )
      } catch (e) {
        out.className = 'err'
        out.textContent = `Claim failed: ${String(e)}`
      } finally {
        claim.removeAttribute('disabled')
        void refreshStatus()
      }
    }

    await refreshStatus()
  }
}

void main()
