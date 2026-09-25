/**
 * Social sign-in ceremonies — identity convenience only.
 *
 * SECURITY CONTRACT: tokens obtained here are shown to the user and used
 * to pre-fill the passkey's display name. They are never stored, never
 * sent to Widespread infrastructure, and NEVER become wallet key
 * material — the passkey PRF is the only secret seed in onboarding.
 *
 * Client-side-safe flows only:
 *   - Google: OIDC implicit `response_type=id_token` in a popup — no
 *     client secret anywhere in the flow.
 *   - GitHub: device flow — polling needs only the public client_id.
 * Providers needing a code→secret exchange must be host-provided
 * (chrome.identity, system-browser + custom scheme) — never embed a
 * client secret here.
 */

import type { SocialIdentity, SocialSignInHook } from './onboarding'

export interface SocialProviderConfig {
  googleClientId?: string
  githubClientId?: string
  /** Where the provider redirects back to (must be registered). */
  redirectUri: string
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('malformed id_token')
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
  return JSON.parse(decodeURIComponent(escape(json)))
}

/** Google: popup implicit flow returning the verified-at-Google id_token claims. */
async function googlePopupSignIn(clientId: string, redirectUri: string): Promise<SocialIdentity> {
  const nonce = crypto.getRandomValues(new Uint8Array(16))
  const nonceHex = Array.from(nonce, (b) => b.toString(16).padStart(2, '0')).join('')
  const url =
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=id_token` +
    `&scope=${encodeURIComponent('openid email profile')}&nonce=${nonceHex}`
  const fragment = await popupForFragment(url)
  const params = new URLSearchParams(fragment)
  const idToken = params.get('id_token')
  if (!idToken) throw new Error(params.get('error') ?? 'no id_token returned')
  const claims = decodeJwtPayload(idToken)
  if (claims.nonce !== nonceHex) throw new Error('id_token nonce mismatch')
  return {
    provider: 'google',
    subject: typeof claims.sub === 'string' ? claims.sub : undefined,
    displayName: (claims.name as string) ?? (claims.email as string),
  }
}

/** GitHub: device flow — display the user_code, poll until the user authorizes. */
async function githubDeviceSignIn(
  clientId: string,
  onUserCode?: (code: string, verificationUri: string) => void,
): Promise<SocialIdentity> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
  })
  if (!res.ok) throw new Error(`device code request failed: ${res.status}`)
  const device = (await res.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    interval: number
    expires_in: number
  }
  onUserCode?.(device.user_code, device.verification_uri)

  const deadline = Date.now() + device.expires_in * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(device.interval, 5) * 1000))
    const poll = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const body = (await poll.json()) as { access_token?: string; error?: string }
    if (body.access_token) {
      const user = await fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${body.access_token}` },
      }).then((r) => r.json() as Promise<{ login?: string; name?: string }>)
      return { provider: 'github', subject: user.login, displayName: user.name ?? user.login }
    }
    if (body.error && body.error !== 'authorization_pending' && body.error !== 'slow_down') {
      throw new Error(`device flow failed: ${body.error}`)
    }
  }
  throw new Error('device flow expired')
}

/** Open a popup and resolve with the redirect fragment ('#id_token=…'). */
function popupForFragment(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const popup = window.open(url, 'wsp-oauth', 'width=520,height=640')
    if (!popup) {
      reject(new Error('popup blocked — allow popups or use the extension sign-in'))
      return
    }
    const timer = setInterval(() => {
      try {
        if (popup.closed) {
          clearInterval(timer)
          reject(new Error('sign-in window closed'))
          return
        }
        // Cross-origin until the provider redirects back to our origin.
        const hash = popup.location.hash
        if (hash) {
          clearInterval(timer)
          popup.close()
          resolve(hash.slice(1))
        }
      } catch {
        /* cross-origin — still on the provider's page */
      }
    }, 400)
  })
}

/**
 * Build a SocialSignInHook for web/PWA surfaces. GitHub needs a user-code
 * display — pass `onUserCode` to render it in your UI (the onboarding view
 * shows it when the hook reports through this callback).
 */
export function makePopupSocialSignIn(
  cfg: SocialProviderConfig,
  onUserCode?: (code: string, verificationUri: string) => void,
): SocialSignInHook {
  return async (provider) => {
    if (provider === 'google') {
      if (!cfg.googleClientId) throw new Error('google sign-in not configured')
      return googlePopupSignIn(cfg.googleClientId, cfg.redirectUri)
    }
    if (provider === 'github') {
      if (!cfg.githubClientId) throw new Error('github sign-in not configured')
      return githubDeviceSignIn(cfg.githubClientId, onUserCode)
    }
    throw new Error(`unsupported provider ${provider}`)
  }
}
