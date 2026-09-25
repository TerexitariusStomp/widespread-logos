//! Per-instruction Risc0 executor cycle counts for the testimonial guest.
//!
//!   cargo run -p testimonial-examples --release --bin cycle_bench

use nssa_core::account::{Account, AccountId, AccountWithMetadata};
use nssa_core::program::{PdaSeed, ProgramId};
use risc0_zkvm::{default_executor, ExecutorEnv};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::Instant;

const TESTIMONIAL_HEX: &str =
    "9aa87b6ba0a722bb79fec3e2dc0ee58fd303c1127d13699fff27e6d7627fb9f4";
const REGISTRY_HEX: &str =
    "be6cd0c3c15e6d6236cadf3af0eb63332473f223c0713256f7a5b83e0fac2cf5";

// Mirror of the generated instruction enum: submit=0, register_self=1,
// update_self=2.
#[derive(Serialize)]
#[allow(dead_code)]
enum Instruction {
    Submit {
        text: String,
        username: String,
        submission_id: String,
    },
    RegisterSelf {
        registry_program_id: [u8; 32],
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
    UpdateSelf {
        registry_program_id: [u8; 32],
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

fn account(id: AccountId, signer: bool) -> AccountWithMetadata {
    AccountWithMetadata {
        account: Account::default(),
        is_authorized: signer,
        account_id: id,
    }
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
    let elf = include_bytes!("../../../methods/guest/target/riscv32im-risc0-zkvm-elf/docker/testimonial.bin");
    let t_pid = pid_from_hex(TESTIMONIAL_HEX);
    let r_pid = pid_from_hex(REGISTRY_HEX);
    let r_bytes = hex_bytes(REGISTRY_HEX);
    let t_bytes = hex_bytes(TESTIMONIAL_HEX);

    let author = account(AccountId::new([7u8; 32]), true);

    // submit: entry PDA = ["testimonial", submission_id]
    let sub_id = "sub-0001";
    let entry_id = compute_pda(&t_pid, &[seed_from_str("testimonial"), seed_from_str(sub_id)]);
    let entry = account(entry_id, false);
    let ix = Instruction::Submit {
        text: "Widespread made onboarding painless".into(),
        username: "alice".into(),
        submission_id: sub_id.into(),
    };
    println!("program | instruction | user_cycles | segments | exec_ms best/mean");
    bench("testimonial/submit", elf, t_pid, None, vec![entry, author], risc0_zkvm::serde::to_vec(&ix).unwrap());

    // register_self top-level → emits chained call to the registry
    let dep_entry_id = compute_pda(&r_pid, &[seed_from_str("deployer_entry"), t_bytes]);
    let dep_entry = account(dep_entry_id, false);
    let ix = Instruction::RegisterSelf {
        registry_program_id: r_bytes,
        name: "widespread-testimonial".into(),
        version: "0.1.0".into(),
        description: "d".into(), tags: "t".into(), idl_cid: "zIdl".into(),
        source_cid: "zSrc".into(), repo_url: "r".into(), commit: "c".into(),
        build_config: "b".into(), registered_at: 1_700_000_000,
    };
    bench("testimonial/register_self", elf, t_pid, None, vec![dep_entry], risc0_zkvm::serde::to_vec(&ix).unwrap());
}
