/**
 * Passkey ceremonies — WebAuthn PRF for the identity factor.
 *
 * The PRF extension turns a synced platform passkey into a deterministic
 * 32-byte secret WITHOUT exposing key material: the authenticator evaluates
 * PRF(salt) internally and returns only the output. We use a fixed salt —
 * the passkey itself is the entropy; the output seeds `deriveFromPrf`.
 *
 * RP-ID note: passkeys are bound to the creating origin. Surfaces that can
 * load this UI from https://widespread.fyi share one RP ID (one synced
 * passkey covers all of them); extension origins get their own passkey or
 * fall back to kit/device pairing — see the plan's portability table.
 */

const PRF_SALT_INFO = 'widespread-vault-v1'

export interface PasskeyResult {
  /** Raw credential id — needed later for `getPasskeyPrf`. */
  credentialId: Uint8Array
  /** 32-byte PRF output — input to `deriveFromPrf`. Never leaves the client. */
  prfOutput: Uint8Array
}

function prfSalt(): Uint8Array {
  // Fixed salt: PRF output must be reproducible on every device where the
  // synced passkey is available. Salted HKDF happens inside deriveFromPrf.
  return new TextEncoder().encode(PRF_SALT_INFO)
}

function readPrfResult(cred: Credential): Uint8Array {
  const ext = (cred as PublicKeyCredential).getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } }
  }
  const first = ext.prf?.results?.first
  if (!first) throw new Error('passkey did not return a PRF result (unsupported authenticator?)')
  return new Uint8Array(first)
}

/** Create a new platform passkey and immediately evaluate its PRF. */
export async function createPasskeyWithPrf(
  userName: string,
  displayName: string,
): Promise<PasskeyResult> {
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: challenge.buffer as ArrayBuffer,
      rp: { name: 'Widespread' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer,
        name: userName,
        displayName,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256 fallback
      ],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
      extensions: {
        prf: { eval: { first: prfSalt().buffer as ArrayBuffer } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('passkey creation cancelled')
  return {
    credentialId: new Uint8Array(cred.rawId),
    prfOutput: readPrfResult(cred),
  }
}

/** Re-evaluate PRF for an existing passkey (recovery / unlock path). */
export async function getPasskeyPrf(credentialId: Uint8Array): Promise<Uint8Array> {
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: challenge.buffer as ArrayBuffer,
      allowCredentials: [
        {
          type: 'public-key',
          id: credentialId.slice().buffer as ArrayBuffer,
          transports: ['internal', 'hybrid'],
        },
      ],
      userVerification: 'preferred',
      extensions: {
        prf: { eval: { first: prfSalt().buffer as ArrayBuffer } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('passkey assertion cancelled')
  return readPrfResult(cred)
}

/** Whether this context can run the PRF ceremony at all. */
export function passkeyPrfSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.credentials?.create &&
    typeof PublicKeyCredential !== 'undefined'
  )
}
