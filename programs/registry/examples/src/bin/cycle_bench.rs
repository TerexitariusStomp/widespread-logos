//! Per-instruction Risc0 executor cycle counts for the registry guest.
//! Same measurement model as upstream `tools/cycle_bench`: deterministic
//! `SessionInfo::cycles()`, plus best/mean wall time over 5 timed samples
//! (1 warmup discarded).
//!
//!   cargo run -p registry-examples --release --bin cycle_bench

use nssa_core::account::{Account, AccountId, AccountWithMetadata, Data};
use nssa_core::program::{PdaSeed, ProgramId};
use risc0_zkvm::{default_executor, ExecutorEnv};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::Instant;

const REGISTRY_HEX: &str =
    "be6cd0c3c15e6d6236cadf3af0eb63332473f223c0713256f7a5b83e0fac2cf5";

#[derive(Serialize)]
#[allow(dead_code)]
enum Instruction {
    RegisterDeployer {
        program: [u8; 32],
        name: String,
        version: String,
        description: String,
        tags: String,
        idl_cid: String,
        source_cid: String,
        repo_url: String,
        commit: String,
        build_config: String,
        registered_at: u64,
    },
    RegisterSelf {
        program: [u8; 32],
        name: String,
        version: String,
        description: String,
        tags: String,
        idl_cid: String,
        source_cid: String,
        repo_url: String,
        commit: String,
        build_config: String,
        registered_at: u64,
    },
    RegisterThirdParty {
        name: String,
        version: String,
        description: String,
        tags: String,
        idl_cid: String,
        source_cid: String,
        repo_url: String,
        commit: String,
        build_config: String,
        registered_at: u64,
    },
    UpdateDeployer {
        program: [u8; 32],
        version: String,
        description: String,
        tags: String,
        idl_cid: String,
        source_cid: String,
        repo_url: String,
        commit: String,
        build_config: String,
    },
    UpdateThirdParty {
        version: String,
        description: String,
        tags: String,
        idl_cid: String,
        source_cid: String,
        repo_url: String,
        commit: String,
        build_config: String,
    },
    UpdateSelf {
        version: String,
        description: String,
        tags: String,
        idl_cid: String,
        source_cid: String,
        repo_url: String,
        commit: String,
        build_config: String,
    },
}

/// Mirror of the guest's `#[account_type] RegistryEntry` for pre-populating
/// entry data on the update paths.
#[derive(borsh::BorshSerialize)]
struct RegistryEntry {
    program_id: [u8; 32],
    author: [u8; 32],
    kind: u8,
    name: String,
    version: String,
    description: String,
    tags: String,
    idl_cid: String,
    source_cid: String,
    repo_url: String,
    commit: String,
    build_config: String,
    registered_at: u64,
}

fn hex_bytes(h: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, c) in h.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap();
    }
    out
}

fn pid_from_hex(h: &str) -> ProgramId {
    let b = hex_bytes(h);
    let mut id = [0u32; 8];
    for (i, w) in id.iter_mut().enumerate() {
        *w = u32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
    }
    id
}

fn seed_from_str(s: &str) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[..s.len()].copy_from_slice(s.as_bytes());
    b
}

fn compute_pda(program_id: &ProgramId, seeds: &[[u8; 32]]) -> AccountId {
    let combined = if seeds.len() == 1 {
        seeds[0]
    } else {
        let mut hasher = Sha256::new();
        for s in seeds {
            hasher.update(s);
        }
        hasher.finalize().into()
    };
    AccountId::for_public_pda(program_id, &PdaSeed::new(combined))
}

fn account(id: AccountId, signer: bool) -> AccountWithMetadata {
    AccountWithMetadata {
        account: Account::default(),
        is_authorized: signer,
        account_id: id,
    }
}

fn fields() -> (String, String, String, String, String, String, String, String, String, u64) {
    (
        "widespread-registry".into(),
        "0.1.0".into(),
        "LP-0023 program registry".into(),
        "widespread,registry".into(),
        "zDvZRwzmIdlCid".into(),
        "zDvZRwzmSrcCid".into(),
        "github.com/widespread".into(),
        "47eba256".into(),
        "cargo-risczero docker".into(),
        1_700_000_000u64,
    )
}

fn live_entry(entry_id: AccountId, pid_bytes: [u8; 32], author: AccountId, kind: u8) -> AccountWithMetadata {
    let (name, version, description, tags, idl_cid, source_cid, repo_url, commit, build_config, registered_at) = fields();
    let state = RegistryEntry {
        program_id: pid_bytes,
        author: *author.value(),
        kind,
        name, version, description, tags, idl_cid, source_cid, repo_url, commit, build_config,
        registered_at,
    };
    let mut a = account(entry_id, false);
    a.account.data = Data::try_from(borsh::to_vec(&state).unwrap()).unwrap();
    a
}

fn bench(label: &str, elf: &[u8], self_pid: ProgramId, caller: Option<ProgramId>, pre_states: Vec<AccountWithMetadata>, words: Vec<u32>) {
    let exec = default_executor();
    let mut samples = Vec::new();
    let (mut cycles, mut segments) = (0u64, 0usize);
    for i in 0..6 {
        let env = ExecutorEnv::builder()
            .write(&self_pid).unwrap()
            .write(&caller).unwrap()
            .write(&pre_states).unwrap()
            .write(&words).unwrap()
            .build().unwrap();
        let t = Instant::now();
        let info = exec.execute(env, elf).unwrap_or_else(|e| panic!("{label}: exec failed: {e}"));
        if i > 0 {
            samples.push(t.elapsed().as_secs_f64() * 1e3);
        }
        cycles = info.cycles();
        segments = info.segments.len();
    }
    let best = samples.iter().cloned().fold(f64::MAX, f64::min);
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    println!("{label:52} {cycles:>10} cycles  {segments} seg  exec {best:6.1} / {mean:6.1} ms");
}

fn main() {
    let elf = include_bytes!("../../../methods/guest/target/riscv32im-risc0-zkvm-elf/docker/registry.bin");
    let pid = pid_from_hex(REGISTRY_HEX);
    let pid_bytes = hex_bytes(REGISTRY_HEX);
    let (name, version, description, tags, idl_cid, source_cid, repo_url, commit, build_config, registered_at) = fields();

    let author_id = AccountId::new([7u8; 32]);
    let dep_entry_id = compute_pda(&pid, &[seed_from_str("deployer_entry"), pid_bytes]);
    let tp_entry_id = compute_pda(&pid, &[seed_from_str("third_party_entry"), *author_id.value(), *author_id.value()]);
    let dep_entry = account(dep_entry_id, false);
    let tp_entry = account(tp_entry_id, false);
    let program_acc = account(author_id, false); // described program's account-id form
    let author = account(author_id, true);

    println!("program | instruction | user_cycles | segments | exec_ms best/mean");

    // 1. register_self top-level → emits chained call
    let ix = Instruction::RegisterSelf {
        program: pid_bytes,
        name: name.clone(), version: version.clone(), description: description.clone(),
        tags: tags.clone(), idl_cid: idl_cid.clone(), source_cid: source_cid.clone(),
        repo_url: repo_url.clone(), commit: commit.clone(), build_config: build_config.clone(),
        registered_at,
    };
    bench("registry/register_self", elf, pid, None, vec![dep_entry.clone()], risc0_zkvm::serde::to_vec(&ix).unwrap());

    // 2. register_deployer chained (caller = self)
    let ix = Instruction::RegisterDeployer {
        program: pid_bytes,
        name: name.clone(), version: version.clone(), description: description.clone(),
        tags: tags.clone(), idl_cid: idl_cid.clone(), source_cid: source_cid.clone(),
        repo_url: repo_url.clone(), commit: commit.clone(), build_config: build_config.clone(),
        registered_at,
    };
    bench("registry/register_deployer (chained)", elf, pid, Some(pid), vec![dep_entry.clone()], risc0_zkvm::serde::to_vec(&ix).unwrap());

    // 3. register_third_party signed
    let ix = Instruction::RegisterThirdParty {
        name, version, description, tags, idl_cid, source_cid, repo_url, commit, build_config,
        registered_at,
    };
    bench("registry/register_third_party", elf, pid, None, vec![tp_entry.clone(), program_acc.clone(), author.clone()], risc0_zkvm::serde::to_vec(&ix).unwrap());

    // 4. update_self top-level → emits chained call (entry need not be live: PDA check only)
    let ix = Instruction::UpdateSelf {
        version: "0.2.0".into(), description: "d".into(), tags: "t".into(),
        idl_cid: "zNewIdl".into(), source_cid: "zNewSrc".into(), repo_url: "r".into(),
        commit: "c2".into(), build_config: "b".into(),
    };
    bench("registry/update_self", elf, pid, None, vec![dep_entry.clone()], risc0_zkvm::serde::to_vec(&ix).unwrap());

    // 5. update_deployer chained — decodes + rewrites a live entry
    let ix = Instruction::UpdateDeployer {
        program: pid_bytes,
        version: "0.2.0".into(), description: "d".into(), tags: "t".into(),
        idl_cid: "zNewIdl".into(), source_cid: "zNewSrc".into(), repo_url: "r".into(),
        commit: "c2".into(), build_config: "b".into(),
    };
    bench("registry/update_deployer (chained)", elf, pid, Some(pid), vec![live_entry(dep_entry_id, pid_bytes, author_id, 0)], risc0_zkvm::serde::to_vec(&ix).unwrap());

    // 6. update_third_party signed — decodes + rewrites a live entry
    let ix = Instruction::UpdateThirdParty {
        version: "0.2.0".into(), description: "d".into(), tags: "t".into(),
        idl_cid: "zNewIdl".into(), source_cid: "zNewSrc".into(), repo_url: "r".into(),
        commit: "c2".into(), build_config: "b".into(),
    };
    bench("registry/update_third_party", elf, pid, None, vec![live_entry(tp_entry_id, pid_bytes, author_id, 1), program_acc, author], risc0_zkvm::serde::to_vec(&ix).unwrap());
}
