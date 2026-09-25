#![no_main]

//! Widespread program registry — LP-0023 on-chain component (SPEL).
//!
//! Two entry kinds, distinguishable on-chain by PDA namespace:
//!
//!   * Deployer entries at `["deployer_entry", program]` — created only when
//!     the *program account itself* signs. LEZ program accounts are
//!     authorized accounts (the loader's CreateHeader requires
//!     `is_authorized`), so whoever holds the deploy keys can produce that
//!     signature and nobody else can: an unauthorized deployer-entry attempt
//!     is rejected at the signer check. This is the LEZ analogue of
//!     Solana's upgrade-authority signature.
//!   * Third-party entries at `["third_party_entry", program, author]` —
//!     anyone may attest; the recorded author is the signer.
//!
//! Metadata lives on-chain; the IDL and source snapshots live on Logos
//! Storage and are referenced by CID (gas-bounded pointers, per the spec's
//! documented on/off-chain split).
//!
//! Updates are author-only: the deployer entry requires the program
//! account's signature again; a third-party entry requires the recorded
//! author's signature, checked against on-chain state.

use spel_framework::prelude::*;
use nssa_core::account::Data;

risc0_zkvm::guest::entry!(main);

#[lez_program]
mod registry {
    #[allow(unused_imports)]
    use super::*;

    /// Entry kind discriminator — part of the recorded state so clients can
    /// distinguish deployer claims from third-party attestations on-chain.
    pub const KIND_DEPLOYER: u8 = 0;
    pub const KIND_THIRD_PARTY: u8 = 1;

    /// One registry entry. All pointers are Logos Storage CIDs or forge
    /// references — no content on-chain beyond bounded metadata.
    #[derive(BorshSerialize, BorshDeserialize)]
    #[account_type]
    pub struct RegistryEntry {
        /// The program being described.
        pub program_id: [u8; 32],
        /// The registrant account (signer at registration).
        pub author: [u8; 32],
        /// KIND_DEPLOYER or KIND_THIRD_PARTY.
        pub kind: u8,
        pub name: String,
        pub version: String,
        pub description: String,
        /// Comma-separated tags for search.
        pub tags: String,
        /// Logos Storage CID of the program IDL.
        pub idl_cid: String,
        /// Logos Storage CID of the source snapshot.
        pub source_cid: String,
        /// Forge URL (e.g. github.com/x/y) — informational; source_cid is
        /// the liveness-independent mirror.
        pub repo_url: String,
        /// Source commit the verified-source claim pins to.
        pub commit: String,
        /// Build configuration sufficient to reproduce the bytecode
        /// (pinned toolchain / nix ref / build command).
        pub build_config: String,
        /// Unix timestamp supplied at registration; the authoritative
        /// timestamp is the entry's block inclusion (chain data).
        pub registered_at: u64,
    }

    /// ProgramId (8 little-endian u32 words) rendered as 32 bytes — the
    /// canonical program identifier used for `program_id`/`author` fields
    /// and `arg("program")` PDA seeds.
    fn program_id_bytes(id: &nssa_core::program::ProgramId) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, w) in id.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
        }
        out
    }

    fn validate_entry(
        name: &str,
        version: &str,
        description: &str,
        idl_cid: &str,
        source_cid: &str,
        commit: &str,
    ) -> Result<(), SpelError> {
        if name.is_empty() || name.len() > 64 {
            return Err(SpelError::custom(1, "name must be 1..=64 chars"));
        }
        if version.is_empty() || version.len() > 32 {
            return Err(SpelError::custom(2, "version must be 1..=32 chars"));
        }
        if description.len() > 512 {
            return Err(SpelError::custom(3, "description must be <=512 chars"));
        }
        if idl_cid.is_empty() {
            return Err(SpelError::custom(4, "idl_cid is required"));
        }
        if source_cid.is_empty() {
            return Err(SpelError::custom(5, "source_cid is required"));
        }
        if commit.is_empty() || commit.len() > 64 {
            return Err(SpelError::custom(6, "commit must be 1..=64 chars"));
        }
        Ok(())
    }

    fn write_entry(
        entry: &mut AccountWithMetadata,
        state: &RegistryEntry,
    ) -> Result<(), SpelError> {
        let bytes = borsh::to_vec(state)
            .map_err(|e| SpelError::SerializationError { message: e.to_string() })?;
        entry.account.data =
            Data::try_from(bytes).map_err(|_| SpelError::custom(7, "entry exceeds data cap"))?;
        Ok(())
    }

    /// Register a program's deployer entry. Deployment transactions are
    /// unsigned — the only on-chain proof that "this is really the program"
    /// is `caller_program_id`, which the state machine sets to the *calling*
    /// program (all-zeros for a top-level user call). A deployer entry can
    /// therefore only be created by a chained call FROM the registered
    /// program itself — an unauthorized deployer-entry attempt (a direct
    /// call, or a chained call naming a different program) is rejected here.
    /// Programs expose a `register_self`-style hook for this; see
    /// `register_self` below for this program's own.
    #[instruction]
    pub fn register_deployer(
        ctx: ProgramContext,
        #[account(init, pda = [literal("deployer_entry"), arg("program")])]
        mut entry: AccountWithMetadata,
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
    ) -> SpelResult {
        if ctx.caller_program_id == nssa_core::program::DEFAULT_PROGRAM_ID {
            return Err(SpelError::Unauthorized {
                message: "deployer entries require a chained call from the program itself".into(),
            });
        }
        let caller_bytes = program_id_bytes(&ctx.caller_program_id);
        if caller_bytes != program {
            return Err(SpelError::Unauthorized {
                message: "caller_program_id does not match the registered program".into(),
            });
        }
        validate_entry(&name, &version, &description, &idl_cid, &source_cid, &commit)?;
        write_entry(
            &mut entry,
            &RegistryEntry {
                program_id: program,
                author: caller_bytes,
                kind: KIND_DEPLOYER,
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
        )?;
        Ok(SpelOutput::execute(vec![entry], vec![]))
    }

    /// This program's own registration hook: emits a chained call to the
    /// registry (which is itself here) carrying `register_deployer` — the
    /// only path that satisfies the caller check. `entry` is the
    /// deployer-entry PDA being initialized, declared as a plain mention —
    /// it cannot be `#[account(init, pda)]` here: the init claim must be
    /// emitted by the callee (register_deployer), not this instruction.
    #[instruction]
    pub fn register_self(
        ctx: ProgramContext,
        entry: AccountWithMetadata,
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
    ) -> SpelResult {
        let self_bytes = program_id_bytes(&ctx.self_program_id);
        if self_bytes != program {
            return Err(SpelError::Unauthorized {
                message: "register_self may only register this program".into(),
            });
        }
        let ns = seed_from_str("deployer_entry");
        let expected = compute_pda(&ctx.self_program_id, &[&ns, &self_bytes]);
        if entry.account_id != expected {
            return Err(SpelError::custom(11, "entry is not this program's deployer PDA"));
        }
        if entry.account != nssa_core::account::Account::default() {
            return Err(SpelError::custom(12, "deployer entry already exists"));
        }
        let instruction = Instruction::RegisterDeployer {
            program,
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
        };
        let call = nssa_core::program::ChainedCall::new(
            ctx.self_program_id,
            vec![entry.clone()],
            &instruction,
        );
        // `entry` must also appear in post_states — the sequencer requires
        // post_states.len() == pre_states.len(); it passes through unchanged
        // (the callee performs the real write).
        Ok(SpelOutput::execute(vec![entry], vec![call]))
    }

    /// Register a third-party entry for someone else's program. The signer
    /// is recorded as the entry's author; no deployer claim is made.
    #[instruction]
    pub fn register_third_party(
        _ctx: ProgramContext,
        #[account(init, pda = [literal("third_party_entry"), account("program"), account("author")])]
        mut entry: AccountWithMetadata,
        program: AccountWithMetadata,
        #[account(signer)]
        author: AccountWithMetadata,
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
        validate_entry(&name, &version, &description, &idl_cid, &source_cid, &commit)?;
        write_entry(
            &mut entry,
            &RegistryEntry {
                program_id: *program.account_id.value(),
                author: *author.account_id.value(),
                kind: KIND_THIRD_PARTY,
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
        )?;
        Ok(SpelOutput::execute(vec![entry, program, author], vec![]))
    }

    /// Update the deployer entry (version, IDL/source pointers, metadata).
    /// Same on-chain gate as registration: only the program itself, calling
    /// in via a chained call, may update its deployer entry.
    #[instruction]
    pub fn update_deployer(
        ctx: ProgramContext,
        #[account(mut, pda = [literal("deployer_entry"), arg("program")])]
        mut entry: AccountWithMetadata,
        program: [u8; 32],
        version: String,
        description: String,
        tags: String,
        idl_cid: String,
        source_cid: String,
        repo_url: String,
        commit: String,
        build_config: String,
    ) -> SpelResult {
        let data: Vec<u8> = entry.account.data.clone().into();
        let mut state: RegistryEntry =
            borsh::from_slice(&data).map_err(|e| SpelError::DeserializationError {
                account_index: 0,
                message: e.to_string(),
            })?;
        if state.kind != KIND_DEPLOYER {
            return Err(SpelError::custom(8, "not a deployer entry"));
        }
        if ctx.caller_program_id == nssa_core::program::DEFAULT_PROGRAM_ID
            || program_id_bytes(&ctx.caller_program_id) != program
        {
            return Err(SpelError::Unauthorized {
                message: "only the program itself may update its deployer entry".into(),
            });
        }
        state.version = version;
        state.description = description;
        state.tags = tags;
        state.idl_cid = idl_cid;
        state.source_cid = source_cid;
        state.repo_url = repo_url;
        state.commit = commit;
        state.build_config = build_config;
        write_entry(&mut entry, &state)?;
        Ok(SpelOutput::execute(vec![entry], vec![]))
    }

    /// Update a third-party entry — only the recorded author may.
    #[instruction]
    pub fn update_third_party(
        _ctx: ProgramContext,
        #[account(mut, pda = [literal("third_party_entry"), account("program"), account("author")])]
        mut entry: AccountWithMetadata,
        program: AccountWithMetadata,
        #[account(signer)]
        author: AccountWithMetadata,
        version: String,
        description: String,
        tags: String,
        idl_cid: String,
        source_cid: String,
        repo_url: String,
        commit: String,
        build_config: String,
    ) -> SpelResult {
        let data: Vec<u8> = entry.account.data.clone().into();
        let mut state: RegistryEntry =
            borsh::from_slice(&data).map_err(|e| SpelError::DeserializationError {
                account_index: 0,
                message: e.to_string(),
            })?;
        if state.kind != KIND_THIRD_PARTY {
            return Err(SpelError::custom(9, "not a third-party entry"));
        }
        if *author.account_id.value() != state.author {
            return Err(SpelError::Unauthorized {
                message: "only the entry author may update".into(),
            });
        }
        state.version = version;
        state.description = description;
        state.tags = tags;
        state.idl_cid = idl_cid;
        state.source_cid = source_cid;
        state.repo_url = repo_url;
        state.commit = commit;
        state.build_config = build_config;
        write_entry(&mut entry, &state)?;
        Ok(SpelOutput::execute(vec![entry, program, author], vec![]))
    }

    /// This program's own deployer-entry update hook — emits a chained call
    /// to itself carrying `update_deployer`.
    #[instruction]
    pub fn update_self(
        ctx: ProgramContext,
        entry: AccountWithMetadata,
        version: String,
        description: String,
        tags: String,
        idl_cid: String,
        source_cid: String,
        repo_url: String,
        commit: String,
        build_config: String,
    ) -> SpelResult {
        let self_bytes = program_id_bytes(&ctx.self_program_id);
        let ns = seed_from_str("deployer_entry");
        let expected = compute_pda(&ctx.self_program_id, &[&ns, &self_bytes]);
        if entry.account_id != expected {
            return Err(SpelError::custom(10, "entry is not this program's deployer PDA"));
        }
        let instruction = Instruction::UpdateDeployer {
            program: self_bytes,
            version,
            description,
            tags,
            idl_cid,
            source_cid,
            repo_url,
            commit,
            build_config,
        };
        let call = nssa_core::program::ChainedCall::new(
            ctx.self_program_id,
            vec![entry.clone()],
            &instruction,
        );
        // `entry` must also appear in post_states — the sequencer requires
        // post_states.len() == pre_states.len(); it passes through unchanged
        // (the callee performs the real write).
        Ok(SpelOutput::execute(vec![entry], vec![call]))
    }
}
