/* tslint:disable */
/* eslint-disable */

export function account_id_from_base58(s: string): string | undefined;

export function account_id_to_base58(id_hex: string): string | undefined;

/**
 * Decode a borsh `Account` (public account `data`-adjacent shapes or a
 * decrypted post-state) to JSON.
 */
export function account_to_json(account_borsh_hex: string): string | undefined;

export function compute_private_pda_b58(program_id_hex: string, seeds_hex: string[], npk_hex: string, vpk_hex: string, identifier: string): string | undefined;

/**
 * Public PDA: `seeds_hex` is one or more 32-byte seeds (hex). Multi-seed
 * inputs combine exactly as SPEL `compute_pda` does.
 */
export function compute_public_pda_b58(program_id_hex: string, seeds_hex: string[]): string | undefined;

/**
 * Fast scan filter: `EncryptedAccountData::compute_view_tag`.
 */
export function compute_view_tag(npk_hex: string, vpk_hex: string): number | undefined;

/**
 * Receiver-side shared secret: ML-KEM-768 decapsulation of the ephemeral key
 * embedded in an `EncryptedAccountData`, from the viewing-seed halves.
 */
export function decapsulate_shared_secret(d_hex: string, z_hex: string, epk_hex: string): string | undefined;

/**
 * Decrypt one private post-state.
 *
 * `ead_borsh_hex` is the borsh-serialized `EncryptedAccountData` from the
 * transaction message (the on-chain wire object — carries ciphertext, epk and
 * view tag). `nullifier_hex` is the action's 32-byte nullifier.
 *
 * Returns JSON `{kind, accountId, account}` or null when the tag/keys don't
 * match — matching the wallet's "skip non-matching outputs" behavior.
 */
export function decrypt_post_state(ead_borsh_hex: string, shared_secret_hex: string, nullifier_hex: string): string | undefined;

/**
 * Complete private-viewing scan step for one tx output: decapsulate the
 * ephemeral key inside `ead` with the viewing-seed halves, then decrypt the
 * post-state. Returns JSON `{kind, account, epk}` or null when the output
 * does not belong to the viewing key — the wallet's "skip non-matching
 * outputs" behavior, keeping all key flow inside the wasm boundary.
 */
export function decrypt_private_output(ead_borsh_hex: string, d_hex: string, z_hex: string, nullifier_hex: string): string | undefined;

/**
 * AccountId for a decrypted private note — needs the npk/vpk that viewed it.
 */
export function private_account_id_b58(npk_hex: string, vpk_hex: string, kind_json: string): string | undefined;

/**
 * utf8 literal → zero-padded 32-byte seed (`spel_framework_core::seed_from_str`).
 */
export function seed_from_str_hex(s: string): string | undefined;

/**
 * Viewing public key from the FIPS-203 seed halves.
 */
export function viewing_public_key_from_seed(d_hex: string, z_hex: string): string | undefined;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly account_id_from_base58: (a: number, b: number) => [number, number];
    readonly account_id_to_base58: (a: number, b: number) => [number, number];
    readonly account_to_json: (a: number, b: number) => [number, number];
    readonly compute_private_pda_b58: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly compute_public_pda_b58: (a: number, b: number, c: number, d: number) => [number, number];
    readonly compute_view_tag: (a: number, b: number, c: number, d: number) => number;
    readonly decapsulate_shared_secret: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly decrypt_post_state: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly decrypt_private_output: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly private_account_id_b58: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly seed_from_str_hex: (a: number, b: number) => [number, number];
    readonly viewing_public_key_from_seed: (a: number, b: number, c: number, d: number) => [number, number];
    readonly sys_write: (a: number, b: number, c: number) => void;
    readonly sys_cycle_count: () => bigint;
    readonly sys_input: (a: number) => number;
    readonly sys_log: (a: number, b: number) => void;
    readonly sys_rand: (a: number, b: number) => void;
    readonly syscall_2_nr: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly sys_halt: (a: number, b: number) => void;
    readonly sys_pause: (a: number, b: number) => void;
    readonly sys_prove_keccak: (a: number, b: number) => void;
    readonly sys_verify_integrity2: (a: number, b: number) => void;
    readonly sys_read: (a: number, b: number, c: number) => number;
    readonly sys_panic: (a: number, b: number) => void;
    readonly sys_verify_integrity: (a: number, b: number) => void;
    readonly sys_read_words: (a: number, b: number, c: number) => number;
    readonly sys_sha_buffer: (a: number, b: number, c: number, d: number) => void;
    readonly sys_sha_compress: (a: number, b: number, c: number, d: number) => void;
    readonly sys_alloc_aligned: (a: number, b: number) => number;
    readonly sys_alloc_words: (a: number) => number;
    readonly sys_argc: () => number;
    readonly sys_argv: (a: number, b: number, c: number) => number;
    readonly sys_bigint: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sys_bigint2_1: (a: number, b: number) => void;
    readonly sys_bigint2_2: (a: number, b: number, c: number) => void;
    readonly sys_bigint2_3: (a: number, b: number, c: number, d: number) => void;
    readonly sys_bigint2_4: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sys_bigint2_5: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly sys_bigint2_6: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly sys_exit: (a: number) => void;
    readonly sys_fork: () => number;
    readonly sys_getenv: (a: number, b: number, c: number, d: number) => number;
    readonly sys_keccak: (a: number, b: number) => number;
    readonly sys_pipe: (a: number) => number;
    readonly sys_poseidon2: (a: number, b: number, c: number, d: number) => void;
    readonly syscall_0: (a: number, b: number, c: number, d: number) => void;
    readonly syscall_0_nr: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly syscall_1: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly syscall_1_nr: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly syscall_2: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly syscall_3: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly syscall_3_nr: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly syscall_4: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly syscall_4_nr: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly syscall_5: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly syscall_5_nr: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
