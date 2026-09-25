/**
 * risc0-serde instruction encoder — byte-exact reimplementation of
 * `risc0_zkvm::serde::to_vec` (Vec<u32> words) as used by spel-cli's
 * `serialize_to_risc0`. Verified against upstream contract tests:
 *
 *   bool/u8/u16/u32/char   → one u32 word
 *   u64                    → two u32 words, little-endian
 *   u128                   → 16 LE bytes packed into 4 words
 *   String / bytes         → u32 byte-length + bytes packed LE, zero-padded
 *   Vec<T>                 → u32 length + per-element serialization
 *                            (Vec<u8>: one word per byte — NOT packed)
 *   [T; N] / tuple         → no length prefix, per-element
 *   Option<T>              → 0 | 1 + value
 *   enum variant           → variant_index u32 + fields in order
 *   struct                 → fields in order, no prefix
 */

export type R0Value =
  | { kind: 'bool'; v: boolean }
  | { kind: 'u8' | 'u16' | 'u32' | 'char'; v: number }
  | { kind: 'u64' | 'i64'; v: bigint }
  | { kind: 'u128'; v: bigint }
  | { kind: 'str'; v: string }
  | { kind: 'bytes'; v: Uint8Array } // Vec<u8> — length + one word per byte
  | { kind: 'array'; v: R0Value[] } // [T; N] — no length prefix
  | { kind: 'seq'; v: R0Value[] } // Vec<T> — length prefix
  | { kind: 'option'; v: R0Value | null }
  | { kind: 'tuple'; v: R0Value[] }
  | { kind: 'variant'; index: number; fields: R0Value[] }

export function r0Bool(v: boolean): R0Value {
  return { kind: 'bool', v }
}
export function r0U32(v: number): R0Value {
  return { kind: 'u32', v }
}
export function r0U64(v: bigint): R0Value {
  return { kind: 'u64', v }
}
export function r0Str(v: string): R0Value {
  return { kind: 'str', v }
}
export function r0Bytes(v: Uint8Array): R0Value {
  return { kind: 'bytes', v }
}
export function r0Array(v: R0Value[]): R0Value {
  return { kind: 'array', v }
}

export function r0U8Array32(v: Uint8Array): R0Value {
  if (v.length !== 32) throw new Error('expected 32 bytes')
  return { kind: 'array', v: Array.from(v).map((b) => ({ kind: 'u8' as const, v: b })) }
}

class WordWriter {
  words: number[] = []
  push(w: number) {
    this.words.push(w >>> 0)
  }
  pushBytesPadded(bytes: Uint8Array) {
    for (let i = 0; i < bytes.length; i += 4) {
      let w = 0
      for (let j = 0; j < 4; j++) w |= (bytes[i + j] ?? 0) << (8 * j)
      this.push(w)
    }
  }
}

function encodeInto(w: WordWriter, v: R0Value): void {
  switch (v.kind) {
    case 'bool':
      w.push(v.v ? 1 : 0)
      break
    case 'u8':
    case 'u16':
    case 'u32':
    case 'char':
      w.push(v.v)
      break
    case 'u64':
    case 'i64': {
      w.push(Number(v.v & 0xffffffffn))
      w.push(Number((v.v >> 32n) & 0xffffffffn))
      break
    }
    case 'u128': {
      const b = new Uint8Array(16)
      for (let i = 0; i < 16; i++) b[i] = Number((v.v >> BigInt(8 * i)) & 0xffn)
      w.pushBytesPadded(b)
      break
    }
    case 'str': {
      const bytes = new TextEncoder().encode(v.v)
      w.push(bytes.length)
      w.pushBytesPadded(bytes)
      break
    }
    case 'bytes': {
      // Vec<u8>: length prefix, then one word per element.
      w.push(v.v.length)
      for (const b of v.v) w.push(b)
      break
    }
    case 'array':
    case 'tuple':
      for (const el of v.v) encodeInto(w, el)
      break
    case 'seq':
      w.push(v.v.length)
      for (const el of v.v) encodeInto(w, el)
      break
    case 'option':
      if (v.v === null) w.push(0)
      else {
        w.push(1)
        encodeInto(w, v.v)
      }
      break
    case 'variant':
      w.push(v.index)
      for (const f of v.fields) encodeInto(w, f)
      break
  }
}

/** Encode one instruction: variant index + args → u32 words. */
export function encodeInstruction(variantIndex: number, args: R0Value[]): Uint32Array {
  const w = new WordWriter()
  encodeInto(w, { kind: 'variant', index: variantIndex, fields: args })
  return Uint32Array.from(w.words)
}

/** u32 words → LE bytes → hex — the `instruction_data_hex` wire form. */
export function wordsToHex(words: Uint32Array): string {
  const b = new Uint8Array(words.length * 4)
  for (let i = 0; i < words.length; i++) {
    b[i * 4] = words[i] & 0xff
    b[i * 4 + 1] = (words[i] >> 8) & 0xff
    b[i * 4 + 2] = (words[i] >> 16) & 0xff
    b[i * 4 + 3] = (words[i] >> 24) & 0xff
  }
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export function instructionDataHex(variantIndex: number, args: R0Value[]): string {
  return wordsToHex(encodeInstruction(variantIndex, args))
}
