//! Wire protocol for the Widespread LEZ wallet worker.
//!
//! One contract, three transports: `wsp-lezd` (browser-extension native
//! messaging), `widespread_wallet` (LogosCore module RPC), and the `wsp-lez`
//! CLI. Account references use the upstream `AccountIdWithPrivacy` string
//! form: `Public/<hex>` or `Private/<hex>`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

/// u128 over the wire as a decimal string (JSON has no u128); accepts a
/// bare number too for CLI convenience.
pub mod u128_str {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Rep {
            Str(String),
            Num(u128),
        }
        match Rep::deserialize(d)? {
            Rep::Str(s) => s.parse().map_err(D::Error::custom),
            Rep::Num(n) => Ok(n),
        }
    }
}

/// A program-shard account mention: `account` selects the on-chain account,
/// `program_account_id` the program account (shard) the mention targets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mention {
    pub account: String,
    /// Ignored under the v0.2 wire protocol (shard selectors are a v0.3
    /// concept); accepted so v0.3-shaped callers don't break.
    #[serde(default)]
    pub program_account_id: Option<String>,
}

/// A foreign (not wallet-owned) private destination, identified by its public
/// key material. Values deserialize into the upstream key types, so hex or
/// upstream-JSON forms both work.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivateDest {
    pub npk: serde_json::Value,
    pub vpk: serde_json::Value,
    pub identifier: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    Ping,
    /// Create a fresh vault: new seed, returns the mnemonic once.
    Init {
        #[serde(default)]
        password: Option<String>,
        /// Zone selector — see `zone.rs`. `None` = LEZ testnet.
        #[serde(default)]
        zone: Option<String>,
    },
    /// Restore a vault from an existing mnemonic.
    Restore {
        mnemonic: String,
        #[serde(default)]
        password: Option<String>,
        #[serde(default)]
        zone: Option<String>,
    },
    /// Open a session: the blob is the serialized wallet storage (the
    /// client-side vault ciphertext's plaintext payload).
    Unlock {
        blob_b64: String,
        #[serde(default)]
        zone: Option<String>,
    },
    /// Drop the session and wipe the unlocked state.
    Lock,
    /// Serialize the current session storage back out as the new blob.
    ExportBlob,
    CreateAccount {
        label: String,
        #[serde(default)]
        private: bool,
    },
    ListAccounts,
    Balance {
        account: String,
    },
    Sync,
    Status,
    /// Map of known program name -> program id on the configured zone.
    Programs,
    /// Native-token transfer; the four visibility combinations are selected
    /// by the `Public/`/`Private/` prefixes of `from` and `to`.
    Transfer {
        from: String,
        /// `to` is required for owned destinations; `to_private` instead
        /// describes a foreign private destination by its public keys.
        #[serde(default)]
        to: Option<String>,
        #[serde(default)]
        to_private: Option<PrivateDest>,
        #[serde(with = "u128_str")]
        amount: u128,
    },
    /// Generic public execution: program + instruction data + mentions.
    ProgramCall {
        program: String,
        instruction_data_hex: String,
        accounts: Vec<Mention>,
        /// Optional fee payer (v0.3 wire concept; unused under v0.2).
        #[serde(default)]
        payer: Option<String>,
    },
    /// Piñata faucet status: pool balance, challenge difficulty, eligibility.
    FaucetInfo,
    /// Solve the live Piñata challenge and submit the claim for `account`.
    FaucetClaim { account: String },
    /// Deploy a SPEL/RISC Zero program ELF to the zone.
    DeployProgram { elf_b64: String },
    /// Upload bytes to a Logos Storage (Codex) node → CID.
    StorageUpload {
        node_url: String,
        data_b64: String,
        filename: String,
    },
    /// Download bytes from a Logos Storage node by CID (network fetch).
    StorageDownload { node_url: String, cid: String },
    /// Look up a program's deployer entry in the on-chain LP-0023 registry.
    /// `program` is the 64-hex image id; `registry` overrides the deployed
    /// registry program id (defaults to the testnet-0.3 deployment).
    RegistryLookup {
        program: String,
        #[serde(default)]
        registry: Option<String>,
    },
    /// Generic public-account read: raw account data for PDAs and other
    /// non-identity accounts (pointer records, registry entries…).
    AccountRead { account: String },
    /// Export the viewing material for a private account (npk, vpk, and the
    /// FIPS-203 viewing-seed halves d/z) so client-side wasm codecs can scan
    /// and decrypt notes without touching spending keys. Internal op — never
    /// page-reachable.
    ExportViewingKey { account: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountEntry {
    pub label: String,
    pub account_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Output {
    Pong {
        protocol: u32,
        engine: String,
    },
    Initialized {
        mnemonic: String,
        blob_b64: String,
    },
    Restored {
        blob_b64: String,
    },
    Unlocked,
    Locked,
    Blob {
        blob_b64: String,
    },
    Account {
        account_id: String,
    },
    Accounts {
        accounts: Vec<AccountEntry>,
    },
    Balance {
        #[serde(with = "u128_str")]
        balance: u128,
    },
    Synced {
        block: u64,
    },
    Status {
        sequencer: String,
        /// The session's zone (LP-0022); `"lez"` for the default testnet.
        #[serde(default)]
        zone: String,
    },
    Programs {
        programs: BTreeMap<String, String>,
    },
    TxHash {
        hash: String,
    },
    Faucet {
        prize: String,
        pool_balance: String,
        claims_remaining: String,
        difficulty_bytes: u8,
        can_claim: bool,
        blocked_reason: Option<String>,
    },
    ProgramDeployed {
        program_id: String,
        tx_hash: String,
        block_id: u64,
    },
    StorageCid { cid: String },
    StorageData { data_b64: String },
    RegistryEntry {
        entry: Option<crate::registry::RegistryEntry>,
    },
    AccountData {
        /// base64 of the raw account data ([] when the account is default).
        data_b64: String,
        program_owner: String,
        balance: String,
        nonce: u64,
    },
    ViewingKey {
        account: String,
        npk_hex: String,
        vpk_hex: String,
        d_hex: String,
        z_hex: String,
    },
    FaucetClaimed {
        account: String,
        amount: String,
        balance_before: String,
        balance_after: String,
        tx_hash: String,
        stale_retries: u32,
    },
}
