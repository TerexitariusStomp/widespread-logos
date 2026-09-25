/**
 * testimonial_ui — the canonical WidespreadLezProvider consumer.
 *
 * Flow: connect (approval-gated) → pick a signing account → write text →
 * the wallet shows the decoded call effect (testimonial.submit) → approve
 * → submit lands on-chain under PDA ["testimonial", submission_id].
 *
 * The submission id is attribution for the adoption metric — each
 * testimonial is independently queryable on-chain by its entry PDA.
 */

import { WidespreadLezProvider } from '../../../sdk/provider/src/index'
import { instructionDataHex, r0Str } from '../../../sdk/registry/src/risc0'
import { computePublicPda, bytesToHex } from '../../../packages/wallet-ui/src/pda'

// testnet-0.3 testimonial deployment (programs/ARTIFACTS.md)
const TESTIMONIAL_PROGRAM =
  '9aa87b6ba0a722bb79fec3e2dc0ee58fd303c1127d13699fff27e6d7627fb9f4'

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
  let accounts: string[] = []
  connectBtn.onclick = async () => {
    connectBtn.textContent = 'Connecting…'
    try {
      accounts = await provider.connect({ name: 'Widespread testimonials' })
      if (!accounts.length) throw new Error('connection rejected')
      connectBtn.remove()
      renderForm()
    } catch (e) {
      connectBtn.textContent = 'Connect wallet'
      app.append(el('p', { class: 'err' }, String(e)))
    }
  }

  function renderForm() {
    const from = el('select') as HTMLSelectElement
    for (const a of accounts) {
      const o = el('option', { value: a }, a) as HTMLOptionElement
      from.append(o)
    }
    const user = el('input', { placeholder: 'username (optional)' }) as HTMLInputElement
    const text = el('textarea', {
      placeholder: 'What do you think of Widespread?',
      rows: '4',
      required: 'true',
    }) as HTMLTextAreaElement
    const submit = el('button', {}, 'Post on-chain')
    const out = el('p')
    app.append(from, user, text, submit, out)

    submit.onclick = async () => {
      out.className = ''
      out.textContent = 'Waiting for wallet approval…'
      try {
        const submissionId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
        const entryPda = await computePublicPda(TESTIMONIAL_PROGRAM, ['testimonial', submissionId])
        const dataHex = instructionDataHex(0, [
          r0Str(text.value),
          r0Str(user.value),
          r0Str(submissionId),
        ])
        const hash = await provider.proposeTransaction({
          program: TESTIMONIAL_PROGRAM,
          instructionDataHex: dataHex,
          accounts: [
            { account: `Public/${entryPda}`, programAccountId: TESTIMONIAL_PROGRAM },
            { account: from.value, programAccountId: TESTIMONIAL_PROGRAM },
          ],
        })
        out.className = 'ok'
        out.innerHTML = ''
        out.append(
          el('span', {}, 'Testimonial submitted — tx '),
          el('code', {}, hash),
          el('span', {}, ` (entry ${entryPda})`),
        )
      } catch (e) {
        out.className = 'err'
        out.textContent = String(e)
      }
    }
  }
}

void main()
