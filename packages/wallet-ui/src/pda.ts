/**
 * Off-chain PDA derivation — mirrors upstream exactly:
 *
 *   seed_i  = utf8 bytes, zero-padded to 32 (strings; max 32 bytes)
 *   pdaSeed = seeds.length == 1 ? seeds[0] : sha256(seed1 ‖ seed2 ‖ …)
 *   account = sha256(prefix ‖ programId ‖ pdaSeed)
 *
 * where prefix = "/LEE/v0.2/AccountId/PDA/" zero-padded to 32 bytes. The
 * hash is risc0's `Impl::hash_bytes`: its CPU impl digests with sha2 and
 * stores words via `u32::from_ne_bytes`, so `Digest::as_bytes()` yields
 * the standard SHA-256 byte order on LE hosts — no word swap.
 *
 * Account ids on the wire are base58 (lee_core AccountId Display/FromStr).
 *
 * See: lee_core AccountId::for_public_pda, spel-framework-core compute_pda,
 * risc0-zkp cpu.rs.
 */

const PDA_PREFIX = (() => {
  const p = new Uint8Array(32)
  p.set(new TextEncoder().encode('/LEE/v0.2/AccountId/PDA/'))
  return p
})()

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const B58_INDEX = new Map(Array.from(B58_ALPHABET).map((c, i) => [c, i]))

export function base58Encode(bytes: Uint8Array): string {
  // Count leading zeros — they become leading '1's.
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  // Convert to base58 by repeated division on a little-endian digit array.
  const digits: number[] = []
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]]
  return out
}

export function base58Decode(s: string): Uint8Array {
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros++
  const bytes: number[] = []
  for (let i = zeros; i < s.length; i++) {
    const v = B58_INDEX.get(s[i])
    if (v === undefined) throw new Error(`invalid base58 char '${s[i]}'`)
    let carry = v
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  const out = new Uint8Array(zeros + bytes.length)
  out.set(bytes.reverse(), zeros)
  return out
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer)
  return new Uint8Array(digest)
}

/** utf8 → zero-padded 32-byte seed (SPEL `seed_from_str`; max 32 bytes). */
export function seedFromStr(s: string): Uint8Array {
  const src = new TextEncoder().encode(s)
  if (src.length > 32) throw new Error(`seed '${s}' exceeds 32 bytes`)
  const seed = new Uint8Array(32)
  seed.set(src)
  return seed
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error('bad hex')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** Accepts a base58 account id or 64-char hex; returns 32 bytes. */
export function accountIdBytes(id: string): Uint8Array {
  const bare = id.replace(/^(Public|Private)\//, '')
  if (/^[0-9a-fA-F]{64}$/.test(bare)) return hexToBytes(bare)
  const b = base58Decode(bare)
  if (b.length !== 32) throw new Error('account id must decode to 32 bytes')
  return b
}

/**
 * Derive the public PDA for `programId` (base58 or hex account id) and
 * string seeds. Returns the base58 account id — the same string the
 * chain uses.
 */
export async function computePublicPda(programId: string, seeds: string[]): Promise<string> {
  const program = accountIdBytes(programId)
  if (seeds.length === 0) throw new Error('PDA requires at least one seed')

  const seedBytes = seeds.map(seedFromStr)
  const combined =
    seedBytes.length === 1
      ? seedBytes[0]
      : await sha256(Uint8Array.from(seedBytes.flatMap((s) => Array.from(s))))

  const input = new Uint8Array(96)
  input.set(PDA_PREFIX, 0)
  input.set(program, 32)
  input.set(combined, 64)
  return base58Encode(await sha256(input))
}
