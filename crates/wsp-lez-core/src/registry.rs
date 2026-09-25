//! On-chain LP-0023 registry reads — deployer-entry lookup by PDA.
//!
//! Mirrors `sdk/registry` byte-for-byte: literal seeds are UTF-8 zero-padded
//! to 32 bytes, multi-seed PDAs combine via SHA-256(seed1 || seed2 || …),
//! and the account id is `AccountId::for_public_pda(program_id, seed)` —
//! the same derivation SPEL produces on-chain.
//!
//! The registered "program" account id is the program-id bytes rendered as
//! an `AccountId` (canonical program identifier — deployment registers
//! `program_id → Program` and materializes no account).

use anyhow::{Context, Result};
use lee::AccountId;
use lee_core::program::PdaSeed;
use sha2::{Digest as _, Sha256};
use wallet::WalletCore;

/// The Widespread registry program id deployed on testnet 0.3
/// (block 23456 — see programs/ARTIFACTS.md). Canonical 64-hex form;
/// `program_id_from_hex` renders it to the wire's [u32; 8].
pub const REGISTRY_PROGRAM_ID_HEX: &str =
    "be6cd0c3c15e6d6236cadf3af0eb63332473f223c0713256f7a5b83e0fac2cf5";

/// 64-hex image id → [u32; 8] (same conversion as `parse_program_id`:
/// each 8-hex group is a big-endian rendering of one little-endian word).
pub fn program_id_from_hex(s: &str) -> Result<[u32; 8]> {
    if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        anyhow::bail!("program id must be the 64-hex-char image id, got '{s}'");
    }
    let mut id = [0u32; 8];
    for (i, w) in id.iter_mut().enumerate() {
        *w = u32::from_str_radix(&s[i * 8..i * 8 + 8], 16).map(u32::swap_bytes)?;
    }
    Ok(id)
}

/// `id.iter().flat_map(u32::to_le_bytes)` — the program id rendered as the
/// 32 account-id bytes (the canonical "program account" convention).
fn program_id_account_bytes(id: &[u32; 8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, w) in id.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
    }
    out
}

fn seed_from_str(s: &str) -> [u8; 32] {
    let src = s.as_bytes();
    assert!(src.len() <= 32, "seed '{s}' exceeds 32 bytes");
    let mut seed = [0u8; 32];
    seed[..src.len()].copy_from_slice(src);
    seed
}

fn hash_seeds(seeds: &[[u8; 32]]) -> [u8; 32] {
    if seeds.len() == 1 {
        return seeds[0];
    }
    let mut input = Vec::with_capacity(seeds.len() * 32);
    for s in seeds {
        input.extend_from_slice(s);
    }
    Sha256::digest(input).into()
}

/// Deployer-entry PDA for `target_program` under `registry_program`.
pub fn deployer_entry_pda(registry_program: &[u32; 8], target_program: &[u32; 8]) -> AccountId {
    let combined = hash_seeds(&[
        seed_from_str("deployer_entry"),
        program_id_account_bytes(target_program),
    ]);
    AccountId::for_public_pda(registry_program, &PdaSeed::new(combined))
}

/// Third-party-entry PDA: seeds [literal, program, author].
pub fn third_party_entry_pda(
    registry_program: &[u32; 8],
    target_program: &[u32; 8],
    author: &AccountId,
) -> AccountId {
    let combined = hash_seeds(&[
        seed_from_str("third_party_entry"),
        program_id_account_bytes(target_program),
        *author.value(),
    ]);
    AccountId::for_public_pda(registry_program, &PdaSeed::new(combined))
}

/// Decoded `RegistryEntry` — field order matches `programs/registry`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RegistryEntry {
    pub program_id: String,
    pub author: String,
    pub kind: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub tags: String,
    pub idl_cid: String,
    pub source_cid: String,
    pub repo_url: String,
    pub commit: String,
    pub build_config: String,
    pub registered_at: u64,
}

pub fn decode_entry(data: &[u8]) -> Result<RegistryEntry> {
    let mut off = 0usize;
    let take = |off: &mut usize, n: usize| -> Result<&[u8]> {
        let end = off.checked_add(n).context("entry overflow")?;
        let s = data
            .get(*off..end)
            .context("entry truncated (fixed field)")?;
        *off = end;
        Ok(s)
    };
    let strf = |off: &mut usize| -> Result<String> {
        let len_bytes = take(off, 4)?;
        let len = u32::from_le_bytes(len_bytes.try_into().unwrap()) as usize;
        let s = take(off, len)?;
        String::from_utf8(s.to_vec()).context("entry string is not utf-8")
    };

    let program_id = AccountId::new(take(&mut off, 32)?.try_into().unwrap()).to_string();
    let author = AccountId::new(take(&mut off, 32)?.try_into().unwrap()).to_string();
    let kind = match take(&mut off, 1)?[0] {
        0 => "deployer",
        _ => "third_party",
    }
    .to_string();
    Ok(RegistryEntry {
        program_id,
        author,
        kind,
        name: strf(&mut off)?,
        version: strf(&mut off)?,
        description: strf(&mut off)?,
        tags: strf(&mut off)?,
        idl_cid: strf(&mut off)?,
        source_cid: strf(&mut off)?,
        repo_url: strf(&mut off)?,
        commit: strf(&mut off)?,
        build_config: strf(&mut off)?,
        registered_at: u64::from_le_bytes(take(&mut off, 8)?.try_into().unwrap()),
    })
}

/// Look up the deployer entry for `target_program` on the deployed registry.
/// `None` = no entry PDA on-chain (unregistered program).
pub async fn lookup_deployer_entry(
    core: &WalletCore,
    registry_program: &[u32; 8],
    target_program: &[u32; 8],
) -> Result<Option<RegistryEntry>> {
    let pda = deployer_entry_pda(registry_program, target_program);
    let account = core.get_account_public(pda).await?;
    if account == lee::Account::default() || account.data.as_ref().is_empty() {
        return Ok(None);
    }
    Ok(Some(decode_entry(account.data.as_ref())?))
}
