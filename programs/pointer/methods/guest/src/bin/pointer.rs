#![no_main]

//! Widespread pointer records — deterministic ptr -> value publication.
//!
//! The vault-recovery location scheme is zero-server: the passkey PRF
//! derives `ptr = H(HKDF(prf, "wsp-ptr"))` locally, and this program makes
//! that ptr resolvable without any Widespread infrastructure. Enrollment
//! publishes the wrapped-share CID at PDA ["ptr", ptr]; recovery derives
//! the same address locally and reads the record.
//!
//! Only the publisher's signature can (over)write the record at their ptr —
//! the record account is init-only, so a ptr is write-once: the first
//! publisher wins it, and enrollment derives ptrs from 32-byte PRF output
//! so collision squatting is not practical.

use spel_framework::prelude::*;
use nssa_core::account::Data;


/// Serde-identical mirror of the registry program's generated `Instruction`
/// enum — only `RegisterDeployer` (variant index 0) is needed for
/// self-registration. Field order must match `register_deployer`'s
/// signature exactly (serde serializes struct-variant fields positionally).
#[allow(dead_code)] // placeholder variants exist only for serde index alignment
#[derive(serde::Serialize)]
enum RegistryInstruction {
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
    /// Indices 1–2 are occupied in the registry's generated enum by
    /// `register_self` / `register_third_party` — declared fieldless here
    /// only to keep `UpdateDeployer` at the correct serde variant index.
    RegisterSelf,
    RegisterThirdParty,
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
}

risc0_zkvm::guest::entry!(main);

#[lez_program]
mod pointer {
    #[allow(unused_imports)]
    use super::*;

    /// A published pointer record.
    #[derive(BorshSerialize, BorshDeserialize)]
    #[account_type]
    pub struct PointerRecord {
        /// The account that published (for audit/debug; not security-load-
        /// bearing — a wrong record yields undecryptable ciphertext).
        pub publisher: [u8; 32],
        /// The resolved value — a Logos Storage CID for wallet records.
        pub value: String,
    }

    /// Publish `value` at PDA ["ptr", `key`]. `key` is the hex/UTF-8 form of
    /// the derived pointer and must fit a 32-byte seed. Init-only: republish
    /// under the same key is rejected (records are write-once; key rotation
    /// is a new key).
    #[instruction]
    pub fn publish(
        _ctx: ProgramContext,
        #[account(init, pda = [literal("ptr"), arg("key")])]
        mut record: AccountWithMetadata,
        #[account(signer)]
        publisher: AccountWithMetadata,
        key: String,
        value: String,
    ) -> SpelResult {
        if key.is_empty() || key.len() > 32 {
            return Err(SpelError::custom(1, "key must be 1..=32 chars"));
        }
        if value.is_empty() || value.len() > 128 {
            return Err(SpelError::custom(2, "value must be 1..=128 chars"));
        }
        let state = PointerRecord {
            publisher: *publisher.account_id.value(),
            value,
        };
        let bytes = borsh::to_vec(&state)
            .map_err(|e| SpelError::SerializationError { message: e.to_string() })?;
        record.account.data =
            Data::try_from(bytes).map_err(|_| SpelError::custom(3, "record exceeds data cap"))?;
        Ok(SpelOutput::execute(vec![record, publisher], vec![]))
    }

    /// ProgramId (8 little-endian u32 words) rendered as 32 bytes — the
    /// canonical program identifier used in registry entries/PDA seeds.
    fn program_id_bytes(id: &ProgramId) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, w) in id.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
        }
        out
    }

    fn program_id_from_bytes(b: &[u8; 32]) -> ProgramId {
        let mut id = [0u32; 8];
        for (i, w) in id.iter_mut().enumerate() {
            *w = u32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
        }
        id
    }

    /// Register this program's LP-0023 deployer entry: emits a chained call
    /// to `registry_program_id` carrying `register_deployer`. The registry
    /// accepts it because `caller_program_id` — set by the state machine to
    /// the *calling* program — matches `program`. This is the only path
    /// that can create the deployer entry; a direct call to the registry
    /// from a user transaction is rejected as unauthorized.
    ///
    /// `entry` is the deployer-entry PDA under the *registry* program —
    /// declared as a plain mention (it cannot be `#[account(init, pda)]`
    /// here: the PDA is derived under the registry's id, not this one) and
    /// validated manually: it must be the right PDA and still default.
    #[instruction]
    pub fn register_self(
        ctx: ProgramContext,
        entry: AccountWithMetadata,
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
    ) -> SpelResult {
        let registry_pid = program_id_from_bytes(&registry_program_id);
        let self_bytes = program_id_bytes(&ctx.self_program_id);
        let ns = seed_from_str("deployer_entry");
        let expected = compute_pda(&registry_pid, &[&ns, &self_bytes]);
        if entry.account_id != expected {
            return Err(SpelError::custom(5, "entry is not this program's deployer PDA"));
        }
        if entry.account != nssa_core::account::Account::default() {
            return Err(SpelError::custom(6, "deployer entry already exists"));
        }
        let call = ChainedCall::new(
            registry_pid,
            vec![entry.clone()],
            &RegistryInstruction::RegisterDeployer {
                program: self_bytes,
                name,
                version,
                description,
                tags,
                idl_cid,
                source_cid,
                repo_url,
                commit,
                build_config,
                registered_at,
            },
        );
        // `entry` passes through unchanged into post_states (required:
        // post_states.len() == pre_states.len()); the callee writes it.
        Ok(SpelOutput::execute(vec![entry], vec![call]))
    }

    /// Update this program's deployer entry — same chained-call proof as
    /// `register_self`, carrying `update_deployer` to the registry.
    /// `entry` is the existing deployer-entry PDA account (must be live).
    #[instruction]
    pub fn update_self(
        ctx: ProgramContext,
        entry: AccountWithMetadata,
        registry_program_id: [u8; 32],
        version: String,
        description: String,
        tags: String,
        idl_cid: String,
        source_cid: String,
        repo_url: String,
        commit: String,
        build_config: String,
    ) -> SpelResult {
        let registry_pid = program_id_from_bytes(&registry_program_id);
        let self_bytes = program_id_bytes(&ctx.self_program_id);
        let ns = seed_from_str("deployer_entry");
        let expected = compute_pda(&registry_pid, &[&ns, &self_bytes]);
        if entry.account_id != expected {
            return Err(SpelError::custom(5, "entry is not this program's deployer PDA"));
        }
        let call = ChainedCall::new(
            registry_pid,
            vec![entry.clone()],
            &RegistryInstruction::UpdateDeployer {
                program: self_bytes,
                version,
                description,
                tags,
                idl_cid,
                source_cid,
                repo_url,
                commit,
                build_config,
            },
        );
        // `entry` passes through unchanged into post_states (required:
        // post_states.len() == pre_states.len()); the callee writes it.
        Ok(SpelOutput::execute(vec![entry], vec![call]))
    }
}
