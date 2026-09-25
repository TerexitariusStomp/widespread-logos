//! Execute the registry guest locally with the same inputs the sequencer
//! feeds it — reproduces on-chain failures deterministically.
//!
//!   cargo run -p registry-examples --bin exec_debug

use nssa_core::account::{Account, AccountId, AccountWithMetadata, Data};
use nssa_core::program::{PdaSeed, ProgramId};
use risc0_zkvm::{default_executor, ExecutorEnv};
use serde::Serialize;
use sha2::{Digest, Sha256};

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

fn fields() -> (String, String, String, String, String, String, String, String, String, u64) {
    (
        "widespread-registry".into(),
        "0.1.0".into(),
        "desc".into(),
        "widespread".into(),
        "zDvIdl".into(),
        "zDvSrc".into(),
        "https://repo".into(),
        "abc123".into(),
        "build".into(),
        1_700_000_000u64,
    )
}

fn run(
    elf: &[u8],
    self_pid: ProgramId,
    caller: Option<ProgramId>,
    pre_states: Vec<AccountWithMetadata>,
    instruction_data: Vec<u32>,
    label: &str,
) {
    let env = ExecutorEnv::builder()
        .write(&self_pid)
        .unwrap()
        .write(&caller)
        .unwrap()
        .write(&pre_states)
        .unwrap()
        .write(&instruction_data)
        .unwrap()
        .build()
        .unwrap();
    let exec = default_executor();
    match exec.execute(env, elf) {
        Ok(info) => {
            let output: nssa_core::program::ProgramOutput = info.journal.decode().unwrap();
            println!("=== {label}: OK");
            println!("    post_states: {}", output.post_states.len());
            for (i, ps) in output.post_states.iter().enumerate() {
                let id = output.pre_states.get(i).map(|p| bs58_encode(&p.account_id)).unwrap_or_default();
                let data: Vec<u8> = ps.account().data.clone().into();
                println!(
                    "      account {} owner={:?} data_len={}",
                    &id[..12.min(id.len())],
                    ps.account().program_owner,
                    data.len(),
                );
            }
            println!("    chained_calls: {}", output.chained_calls.len());
            for c in &output.chained_calls {
                println!("      -> program {:?} pre_states={} ix_words={}", c.program_id, c.pre_states.len(), c.instruction_data.len());
            }
        }
        Err(e) => println!("=== {label}: EXEC FAILED: {e}"),
    }
}

fn main() {
    let elf = include_bytes!("../../../methods/guest/target/riscv32im-risc0-zkvm-elf/docker/registry.bin");
    let pid = pid_from_hex(REGISTRY_HEX);
    let pid_bytes = hex_bytes(REGISTRY_HEX);
    let (name, version, description, tags, idl_cid, source_cid, repo_url, commit, build_config, registered_at) = fields();

    let entry_seed = seed_from_str("deployer_entry");
    let entry_id = compute_pda(&pid, &[entry_seed, pid_bytes]);
    let entry = AccountWithMetadata {
        account: Account::default(),
        is_authorized: false,
        account_id: entry_id,
    };
    println!("entry pda: {}", bs58_encode(&entry_id));

    // 1. register_self top-level (caller=None) — should emit chained call
    let ix = Instruction::RegisterSelf {
        program: pid_bytes,
        name: name.clone(),
        version: version.clone(),
        description: description.clone(),
        tags: tags.clone(),
        idl_cid: idl_cid.clone(),
        source_cid: source_cid.clone(),
        repo_url: repo_url.clone(),
        commit: commit.clone(),
        build_config: build_config.clone(),
        registered_at,
    };
    let words = risc0_zkvm::serde::to_vec(&ix).unwrap();
    run(elf, pid, None, vec![entry.clone()], words, "register_self (caller=None)");

    // 2. The chained call itself: register_deployer with caller=Some(registry)
    let ix2 = Instruction::RegisterDeployer {
        program: pid_bytes,
        name, version, description, tags, idl_cid, source_cid, repo_url, commit, build_config,
        registered_at,
    };
    let words2 = risc0_zkvm::serde::to_vec(&ix2).unwrap();
    run(elf, pid, Some(pid), vec![entry.clone()], words2, "register_deployer (caller=registry)");

    // 3. Unauthorized: register_deployer with caller=None → must reject
    let ix3 = Instruction::RegisterDeployer {
        program: pid_bytes,
        name: "evil".into(),
        version: "0".into(),
        description: "x".into(),
        tags: "x".into(),
        idl_cid: "x".into(),
        source_cid: "x".into(),
        repo_url: "x".into(),
        commit: "x".into(),
        build_config: "x".into(),
        registered_at: 0,
    };
    let words3 = risc0_zkvm::serde::to_vec(&ix3).unwrap();
    run(elf, pid, None, vec![entry.clone()], words3, "register_deployer (caller=None, UNAUTHORIZED)");
}

fn bs58_encode(id: &AccountId) -> String {
    const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let bytes = id.value();
    let mut digits = vec![0u8];
    for &b in bytes.iter() {
        let mut carry = b as usize;
        for d in digits.iter_mut() {
            carry += (*d as usize) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::new();
    for &_b in bytes.iter().take_while(|&&b| b == 0) {
        out.push('1');
    }
    for d in digits.iter().rev() {
        out.push(B58[*d as usize] as char);
    }
    out
}
