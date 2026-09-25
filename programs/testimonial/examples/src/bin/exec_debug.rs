//! Cross-program exec debug: run testimonial's register_self locally, feed
//! the emitted chained call into the registry guest — the exact two-step
//! execution the sequencer performs on-chain.
//!
//!   cargo run -p testimonial-examples --bin exec_debug

use nssa_core::account::{Account, AccountId, AccountWithMetadata};
use nssa_core::program::{PdaSeed, ProgramId};
use risc0_zkvm::{default_executor, ExecutorEnv};
use serde::Serialize;
use sha2::{Digest, Sha256};

const TESTIMONIAL_HEX: &str =
    "9aa87b6ba0a722bb79fec3e2dc0ee58fd303c1127d13699fff27e6d7627fb9f4";
const REGISTRY_HEX: &str =
    "be6cd0c3c15e6d6236cadf3af0eb63332473f223c0713256f7a5b83e0fac2cf5";

// testimonial enum mirror: submit=0, register_self=1, update_self=2
#[derive(Serialize)]
#[allow(dead_code)]
enum TestimonialInstruction {
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

fn main() {
    let t_elf = include_bytes!("../../../methods/guest/target/riscv32im-risc0-zkvm-elf/docker/testimonial.bin");
    let r_elf = include_bytes!("../../../../registry/methods/guest/target/riscv32im-risc0-zkvm-elf/docker/registry.bin");
    let t_pid = pid_from_hex(TESTIMONIAL_HEX);
    let r_pid = pid_from_hex(REGISTRY_HEX);
    let r_bytes = hex_bytes(REGISTRY_HEX);
    let t_bytes = hex_bytes(TESTIMONIAL_HEX);

    let entry_id = compute_pda(&r_pid, &[seed_from_str("deployer_entry"), t_bytes]);
    let entry = AccountWithMetadata {
        account: Account::default(),
        is_authorized: false,
        account_id: entry_id,
    };

    // Step 1: testimonial.register_self top-level (caller=None)
    let ix = TestimonialInstruction::RegisterSelf {
        registry_program_id: r_bytes,
        name: "widespread-testimonial".into(),
        version: "0.1.0".into(),
        description: "d".into(),
        tags: "t".into(),
        idl_cid: "zIdl".into(),
        source_cid: "zSrc".into(),
        repo_url: "r".into(),
        commit: "c".into(),
        build_config: "b".into(),
        registered_at: 1_700_000_000,
    };
    let words = risc0_zkvm::serde::to_vec(&ix).unwrap();
    let env = ExecutorEnv::builder()
        .write(&t_pid).unwrap()
        .write(&Option::<ProgramId>::None).unwrap()
        .write(&vec![entry.clone()]).unwrap()
        .write(&words).unwrap()
        .build().unwrap();
    let exec = default_executor();
    match exec.execute(env, t_elf) {
        Err(e) => println!("register_self EXEC FAILED: {e}"),
        Ok(info) => {
            let out: nssa_core::program::ProgramOutput = info.journal.decode().unwrap();
            println!("register_self OK: {} chained call(s)", out.chained_calls.len());
            for call in &out.chained_calls {
                println!("  -> program {:?} (registry={:?})", call.program_id, r_pid);
                // Step 2: execute the chained call on the registry ELF,
                // caller = testimonial
                let env2 = ExecutorEnv::builder()
                    .write(&r_pid).unwrap()
                    .write(&Some(t_pid)).unwrap()
                    .write(&call.pre_states).unwrap()
                    .write(&call.instruction_data).unwrap()
                    .build().unwrap();
                match exec.execute(env2, r_elf) {
                    Err(e) => println!("  register_deployer EXEC FAILED: {e}"),
                    Ok(info2) => {
                        let out2: nssa_core::program::ProgramOutput = info2.journal.decode().unwrap();
                        println!("  register_deployer OK: {} post state(s)", out2.post_states.len());
                        for (i, ps) in out2.post_states.iter().enumerate() {
                            let data: Vec<u8> = ps.account().data.clone().into();
                            let id = out2.pre_states.get(i).map(|p| String::from_utf8_lossy(&p.account_id.value()[..4]).to_string()).unwrap_or_default();
                            println!("    post[{i}] id~{id} owner={:?} data_len={}", ps.account().program_owner, data.len());
                        }
                    }
                }
            }
        }
    }
}
