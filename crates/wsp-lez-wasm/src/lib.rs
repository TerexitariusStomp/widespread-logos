//! wasm32 facade over the upstream LEZ non-prover codecs.
//!
//! Everything exported here is a thin wrapper on `lee_core` (same tag the
//! testnet runs) and `spel-framework-core` (same rev the on-chain programs
//! build against) — no authored crypto. Proving never crosses this boundary:
//! the browser can do public ops and private *viewing*; private sends stay
//! behind `wsp-lezd`.
//!
//! Byte conventions: keys/ciphertexts/nullifiers move as lowercase hex.
//! `AccountId`s move as base58. Seeds move as hex of the 32-byte seed value
//! (`seed_from_str` covers the literal-utf8 case).

use std::str::FromStr as _;

use borsh::BorshDeserialize as _;
use lee_core::{
    account::{Account, AccountId},
    encryption::{
        EncryptedAccountData, EncryptionScheme, EphemeralPublicKey, SharedSecretKey,
        shared_key_derivation::MlKem768EncapsulationKey,
    },
    program::ProgramId,
    Nullifier, NullifierPublicKey, PrivateAccountKind,
};
use spel_framework_core::pda::{compute_pda, compute_private_pda, seed_from_str};
use wasm_bindgen::prelude::*;

fn hex_bytes(s: &str) -> Option<Vec<u8>> {
    hex::decode(s.trim()).ok()
}

fn hex32(s: &str) -> Option<[u8; 32]> {
    hex_bytes(s)?.try_into().ok()
}

/// Program ids are the canonical image-id hex: each u32 word's little-endian
/// bytes — identical to `wsp-lez-core::worker::parse_program_id`, so the hex
/// is exactly the bytemuck cast of the word array.
fn parse_program_id(s: &str) -> Option<ProgramId> {
    let raw = hex_bytes(s)?;
    if raw.len() != 32 {
        return None;
    }
    let mut words = [0u32; 8];
    for (i, w) in raw.as_chunks::<4>().0.iter().enumerate() {
        words[i] = u32::from_le_bytes(*w);
    }
    Some(words)
}

fn parse_seeds(seeds_hex: Vec<String>) -> Option<Vec<[u8; 32]>> {
    seeds_hex.iter().map(|s| hex32(s)).collect()
}

// ---------------------------------------------------------------------------
// AccountId codecs
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub fn account_id_from_base58(s: &str) -> Option<String> {
    AccountId::from_str(s).ok().map(|id| hex::encode(id.value()))
}

#[wasm_bindgen]
pub fn account_id_to_base58(id_hex: &str) -> Option<String> {
    AccountId::new(hex32(id_hex)?).to_string().into()
}

// ---------------------------------------------------------------------------
// PDA derivation — byte-identical to the on-chain programs
// ---------------------------------------------------------------------------

/// utf8 literal → zero-padded 32-byte seed (`spel_framework_core::seed_from_str`).
#[wasm_bindgen]
pub fn seed_from_str_hex(s: &str) -> Option<String> {
    (s.len() <= 32).then(|| hex::encode(seed_from_str(s)))
}

/// Public PDA: `seeds_hex` is one or more 32-byte seeds (hex). Multi-seed
/// inputs combine exactly as SPEL `compute_pda` does.
#[wasm_bindgen]
pub fn compute_public_pda_b58(program_id_hex: &str, seeds_hex: Vec<String>) -> Option<String> {
    let program_id = parse_program_id(program_id_hex)?;
    let seeds = parse_seeds(seeds_hex)?;
    let refs: Vec<&[u8; 32]> = seeds.iter().collect();
    compute_pda(&program_id, &refs).to_string().into()
}

#[wasm_bindgen]
pub fn compute_private_pda_b58(
    program_id_hex: &str,
    seeds_hex: Vec<String>,
    npk_hex: &str,
    vpk_hex: &str,
    identifier: &str,
) -> Option<String> {
    let program_id = parse_program_id(program_id_hex)?;
    let seeds = parse_seeds(seeds_hex)?;
    let refs: Vec<&[u8; 32]> = seeds.iter().collect();
    let npk = NullifierPublicKey(hex32(npk_hex)?);
    let vpk = MlKem768EncapsulationKey::from_bytes(hex_bytes(vpk_hex)?).ok()?;
    let identifier: u128 = identifier.parse().ok()?;
    compute_private_pda(&program_id, &refs, &npk, &vpk, identifier)
        .to_string()
        .into()
}

// ---------------------------------------------------------------------------
// Private viewing — ML-KEM-768 decapsulation + note decrypt
// ---------------------------------------------------------------------------

/// Viewing public key from the FIPS-203 seed halves.
#[wasm_bindgen]
pub fn viewing_public_key_from_seed(d_hex: &str, z_hex: &str) -> Option<String> {
    let vpk = MlKem768EncapsulationKey::from_seed(&hex32(d_hex)?, &hex32(z_hex)?);
    hex::encode(vpk.to_bytes()).into()
}

/// Fast scan filter: `EncryptedAccountData::compute_view_tag`.
#[wasm_bindgen]
pub fn compute_view_tag(npk_hex: &str, vpk_hex: &str) -> Option<u8> {
    let npk = NullifierPublicKey(hex32(npk_hex)?);
    let vpk = MlKem768EncapsulationKey::from_bytes(hex_bytes(vpk_hex)?).ok()?;
    EncryptedAccountData::compute_view_tag(&npk, &vpk).into()
}

/// Receiver-side shared secret: ML-KEM-768 decapsulation of the ephemeral key
/// embedded in an `EncryptedAccountData`, from the viewing-seed halves.
#[wasm_bindgen]
pub fn decapsulate_shared_secret(d_hex: &str, z_hex: &str, epk_hex: &str) -> Option<String> {
    let ss = SharedSecretKey::decapsulate(
        &EphemeralPublicKey(hex_bytes(epk_hex)?),
        &hex32(d_hex)?,
        &hex32(z_hex)?,
    )?;
    hex::encode(ss.0).into()
}

/// Decrypt one private post-state.
///
/// `ead_borsh_hex` is the borsh-serialized `EncryptedAccountData` from the
/// transaction message (the on-chain wire object — carries ciphertext, epk and
/// view tag). `nullifier_hex` is the action's 32-byte nullifier.
///
/// Returns JSON `{kind, accountId, account}` or null when the tag/keys don't
/// match — matching the wallet's "skip non-matching outputs" behavior.
#[wasm_bindgen]
pub fn decrypt_post_state(
    ead_borsh_hex: &str,
    shared_secret_hex: &str,
    nullifier_hex: &str,
) -> Option<String> {
    let ead = EncryptedAccountData::try_from_slice(&hex_bytes(ead_borsh_hex)?).ok()?;
    let ss = SharedSecretKey(hex32(shared_secret_hex)?);
    let nullifier = Nullifier::try_from_slice(&hex32(nullifier_hex)?).ok()?;
    let (kind, account) = EncryptionScheme::decrypt(&ead.ciphertext, &ss, &nullifier)?;
    serde_json::json!({
        "kind": kind,
        "account": account,
    })
    .to_string()
    .into()
}

/// Complete private-viewing scan step for one tx output: decapsulate the
/// ephemeral key inside `ead` with the viewing-seed halves, then decrypt the
/// post-state. Returns JSON `{kind, account, epk}` or null when the output
/// does not belong to the viewing key — the wallet's "skip non-matching
/// outputs" behavior, keeping all key flow inside the wasm boundary.
#[wasm_bindgen]
pub fn decrypt_private_output(
    ead_borsh_hex: &str,
    d_hex: &str,
    z_hex: &str,
    nullifier_hex: &str,
) -> Option<String> {
    let ead = EncryptedAccountData::try_from_slice(&hex_bytes(ead_borsh_hex)?).ok()?;
    let ss = SharedSecretKey::decapsulate(&ead.epk, &hex32(d_hex)?, &hex32(z_hex)?)?;
    let nullifier = Nullifier::try_from_slice(&hex32(nullifier_hex)?).ok()?;
    let (kind, account) = EncryptionScheme::decrypt(&ead.ciphertext, &ss, &nullifier)?;
    serde_json::json!({
        "kind": kind,
        "account": account,
        "epk": hex::encode(&ead.epk.0),
        "viewTag": ead.view_tag,
    })
    .to_string()
    .into()
}

/// AccountId for a decrypted private note — needs the npk/vpk that viewed it.
#[wasm_bindgen]
pub fn private_account_id_b58(
    npk_hex: &str,
    vpk_hex: &str,
    kind_json: &str,
) -> Option<String> {
    let npk = NullifierPublicKey(hex32(npk_hex)?);
    let vpk = MlKem768EncapsulationKey::from_bytes(hex_bytes(vpk_hex)?).ok()?;
    let kind: PrivateAccountKind = serde_json::from_str(kind_json).ok()?;
    AccountId::for_private_account(&npk, &vpk, &kind)
        .to_string()
        .into()
}

/// Decode a borsh `Account` (public account `data`-adjacent shapes or a
/// decrypted post-state) to JSON.
#[wasm_bindgen]
pub fn account_to_json(account_borsh_hex: &str) -> Option<String> {
    let account = Account::try_from_slice(&hex_bytes(account_borsh_hex)?).ok()?;
    serde_json::to_string(&account).ok()
}
