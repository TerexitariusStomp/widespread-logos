//! Piñata faucet: read the live challenge, solve the proof-of-work, submit
//! the claim transaction, and reconcile the credit against the winner's
//! balance. Follows `lez-faucet-ffi` (MIT OR Apache-2.0) semantics on top of
//! the v0.2.4 `WalletCore`/`Pinata` facade the worker already hosts.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use sha2::{Digest as _, Sha256};
use wallet::program_facades::native_token_transfer::NativeTokenTransfer;
use wallet::program_facades::pinata::Pinata;
use wallet::{AccountIdentity, WalletCore};

/// Claim value on the public testnet (150 LEZ in base units).
pub const PRIZE: u128 = 150;

const CHALLENGE_LEN: usize = 33;
const MAX_SUPPORTED_DIFFICULTY: u8 = 3;
const SOLVE_DEADLINE: Duration = Duration::from_secs(120);
const RECONCILE_DEADLINE: Duration = Duration::from_secs(90);
const MAX_STALE_RETRIES: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Challenge {
    pub difficulty: u8,
    pub seed: [u8; 32],
}

impl Challenge {
    fn parse(data: &[u8]) -> Result<Self> {
        let bytes: [u8; CHALLENGE_LEN] = data
            .try_into()
            .context("pinata challenge data is not 33 bytes")?;
        let difficulty = bytes[0];
        if difficulty > 32 {
            bail!("pinata challenge difficulty {difficulty} exceeds digest size");
        }
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&bytes[1..]);
        Ok(Self { difficulty, seed })
    }

    fn supported(&self) -> bool {
        self.difficulty <= MAX_SUPPORTED_DIFFICULTY
    }
}

fn valid_solution(difficulty: usize, seed: &[u8; 32], solution: u128) -> bool {
    let mut input = [0u8; 48];
    input[..32].copy_from_slice(seed);
    input[32..].copy_from_slice(&solution.to_le_bytes());
    let digest: [u8; 32] = Sha256::digest(input).into();
    digest[..difficulty].iter().all(|b| *b == 0)
}

/// Unpredictable nonce start — a claim carries no signature, so identical
/// scans would build byte-identical transactions (see lez-faucet-ffi notes).
fn random_start() -> u128 {
    use std::hash::{BuildHasher as _, Hasher as _};
    let mix = |salt: u64| {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(salt);
        h.write_u64(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |e| e.subsec_nanos().into()),
        );
        h.finish()
    };
    (u128::from(mix(1)) << 64) | u128::from(mix(2))
}

/// Read the pinata account and validate it is owned by the live pinata
/// program id (protocol fingerprint — a drifted chain is a hard error).
async fn read_challenge(core: &WalletCore) -> Result<(u128, Challenge)> {
    let program_ids = core.get_program_ids().await?;
    let pinata_id = *program_ids
        .get("pinata")
        .context("sequencer reports no pinata program")?;
    let account = core
        .get_account_public(system_accounts::pinata_account_id())
        .await?;
    if account.program_owner != pinata_id {
        bail!("pinata account is not owned by the pinata program");
    }
    let challenge = Challenge::parse(account.data.as_ref())?;
    Ok((account.balance, challenge))
}

async fn solve(challenge: Challenge) -> Result<u128> {
    if !challenge.supported() {
        bail!(
            "pinata difficulty {} exceeds supported max {}",
            challenge.difficulty,
            MAX_SUPPORTED_DIFFICULTY
        );
    }
    let stop = Arc::new(AtomicBool::new(false));
    let stop_worker = Arc::clone(&stop);
    let task = tokio::task::spawn_blocking(move || {
        let mut candidate = random_start();
        loop {
            if stop_worker.load(Ordering::Relaxed) {
                return None;
            }
            if valid_solution(challenge.difficulty.into(), &challenge.seed, candidate) {
                return Some(candidate);
            }
            candidate = candidate.wrapping_add(1);
        }
    });
    tokio::select! {
        r = task => r?.context("solver finished without a solution"),
        () = tokio::time::sleep(SOLVE_DEADLINE) => {
            stop.store(true, Ordering::Relaxed);
            bail!("proof-of-work exceeded the {SOLVE_DEADLINE:?} deadline")
        }
    }
}

/// Recipient state as the upstream faucet reports it: an account can only
/// hold a token-program balance once it is *initialized* — owned by the
/// authenticated-transfer program — which happens via a self-signed
/// `Initialize` transaction (upstream `wallet auth-transfer init`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eligibility {
    Eligible,
    Uninitialized,
    WrongOwner,
}

pub async fn inspect_recipient(
    core: &WalletCore,
    account_id: lee::AccountId,
) -> Result<(Eligibility, u128)> {
    let account = core.get_account_public(account_id).await?;
    if account == lee::Account::default() {
        return Ok((Eligibility::Uninitialized, 0));
    }
    if account.program_owner != programs::authenticated_transfer().id() {
        return Ok((Eligibility::WrongOwner, account.balance));
    }
    Ok((Eligibility::Eligible, account.balance))
}

/// Initialize an owned account on-chain (`authenticated_transfer::Initialize`,
/// self-signed) and poll until the chain reports the token program as owner.
pub async fn register_account(
    core: &WalletCore,
    account_id: lee::AccountId,
) -> Result<String> {
    if core.get_account_public_signing_key(account_id).is_none() {
        bail!("account is not owned by this wallet — it must self-initialize");
    }
    let hash = NativeTokenTransfer(core)
        .register_account(AccountIdentity::Public(account_id))
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let ata_id = programs::authenticated_transfer().id();
    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        let acc = core.get_account_public(account_id).await?;
        if acc.program_owner == ata_id {
            return Ok(hash.to_string());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    bail!("init submitted ({hash}) but ownership was not confirmed within 90s")
}

/// Live faucet status for the UI (pool depth, difficulty, eligibility).
pub async fn faucet_info(
    core: &WalletCore,
) -> Result<(u128, u128, u8, bool, Option<String>)> {
    let (pool, challenge) = read_challenge(core).await?;
    let claims = pool / PRIZE;
    let blocked = if pool < PRIZE {
        Some("pool_depleted")
    } else if !challenge.supported() {
        Some("unsupported_difficulty")
    } else {
        None
    };
    Ok((
        pool,
        claims,
        challenge.difficulty,
        blocked.is_none(),
        blocked.map(str::to_string),
    ))
}

/// Solve the live challenge and claim one drop for `winner_account_id`,
/// reconciling the credit against the winner's balance. Retries while the
/// global challenge rotates under us (other claimants winning the race).
pub async fn claim(
    core: &WalletCore,
    winner_account_id: lee::AccountId,
) -> Result<(u128, u128, String, u32)> {
    let pinata_id = system_accounts::pinata_account_id();
    // The chain only credits initialized accounts: self-register an owned
    // uninitialized recipient first, refuse foreign/wrong-owner ones.
    match inspect_recipient(core, winner_account_id).await? {
        (Eligibility::Uninitialized, _) => {
            register_account(core, winner_account_id).await?;
        }
        (Eligibility::WrongOwner, _) => {
            bail!("recipient is managed by a different program — cannot fund it")
        }
        (Eligibility::Eligible, _) => {}
    }
    let winner = core.get_account_public(winner_account_id).await?;
    let mut balance_before = winner.balance;
    let deadline = Instant::now() + RECONCILE_DEADLINE;

    for attempt in 0..=MAX_STALE_RETRIES {
        let (pool, challenge) = read_challenge(core).await?;
        if pool < PRIZE {
            bail!("faucet pool is depleted");
        }
        if !challenge.supported() {
            bail!(
                "pinata difficulty {} exceeds supported max {MAX_SUPPORTED_DIFFICULTY}",
                challenge.difficulty
            );
        }

        let solution = solve(challenge).await?;

        // Re-check: the challenge rotates whenever anyone else claims.
        let (pool_now, latest) = read_challenge(core).await?;
        if latest != challenge || pool_now < PRIZE {
            continue;
        }
        let current = core.get_account_public(winner_account_id).await?;
        if current.balance != balance_before {
            balance_before = current.balance;
            continue;
        }

        let tx_hash = Pinata(core)
            .claim(pinata_id, winner_account_id, solution)
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;

        // Reconcile on the winner's balance — the definitive success signal.
        let expected = balance_before + PRIZE;
        while Instant::now() < deadline {
            let acc = core.get_account_public(winner_account_id).await?;
            if acc.balance == expected {
                return Ok((balance_before, expected, tx_hash.to_string(), attempt));
            }
            if acc.balance != balance_before {
                bail!(
                    "winner balance moved by {} during claim reconciliation — outcome unknown",
                    acc.balance as i128 - balance_before as i128
                );
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        bail!("claim submitted ({tx_hash}) but the credit was not confirmed within {RECONCILE_DEADLINE:?}");
    }
    bail!("challenge kept rotating under us — other claimants won the race")
}
