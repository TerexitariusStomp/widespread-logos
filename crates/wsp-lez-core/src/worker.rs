//! The shared wallet worker: `execute(op, blob) -> (result, blob')`.
//!
//! The worker is stateless across calls — it reconstructs `WalletCore` from
//! the blob — but holds an *unlocked session* for the duration of a
//! connection (native-messaging session or module lifetime), matching the
//! sealed-vault model: the host encrypts the blob at rest; the worker sees
//! plaintext only in memory and wipes it on `lock`/drop.

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use bip39::Mnemonic;
use tempfile::TempDir;
use wallet::account::AccountIdWithPrivacy;
use wallet::{
    AccountIdentity, WalletCore, account::Label,
    program_facades::native_token_transfer::NativeTokenTransfer,
};


use crate::op::{AccountEntry, Op, Output, PROTOCOL_VERSION};
use crate::zone::{self, ZoneSpec};

/// One unlocked wallet session: a `WalletCore` driven off a private tempdir
/// (config.toml / storage.json / statistics.json). The blob on the wire is
/// the storage.json payload — upstream `PersistentStorage` serialization.
struct Session {
    core: WalletCore,
    storage_path: PathBuf,
    zone: ZoneSpec,
    _dir: TempDir,
}

pub struct Worker {
    rt: Arc<tokio::runtime::Runtime>,
    session: Option<Session>,
}

impl Default for Worker {
    fn default() -> Self {
        Self::new().expect("tokio runtime")
    }
}

impl Worker {
    pub fn new() -> Result<Self> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        Ok(Self {
            rt: Arc::new(rt),
            session: None,
        })
    }

    pub fn is_unlocked(&self) -> bool {
        self.session.is_some()
    }

    /// Execute one op. Returns the op output; blob-bearing ops
    /// (`init`/`restore`/`export_blob`) carry the serialized storage.
    pub fn execute(&mut self, op: Op) -> Result<Output> {
        let rt = self.rt.clone();
        rt.block_on(self.execute_async(op))
    }

    async fn execute_async(&mut self, op: Op) -> Result<Output> {
        match op {
            Op::Ping => Ok(Output::Pong {
                protocol: PROTOCOL_VERSION,
                engine: "lez/wallet@v0.2.4-testnet".to_string(),
            }),
            Op::Init { password, zone } => self.init(password, zone.as_deref()).await,
            Op::Restore {
                mnemonic,
                password,
                zone,
            } => self.restore(&mnemonic, password, zone.as_deref()).await,
            Op::Unlock { blob_b64, zone } => self.unlock(&blob_b64, zone.as_deref()).await,
            Op::Lock => {
                self.session = None; // TempDir drop removes session files.
                Ok(Output::Locked)
            }
            Op::ExportBlob => self.export_blob(),
            Op::CreateAccount { label, private } => self.create_account(&label, private),
            Op::ListAccounts => self.list_accounts(),
            Op::Balance { account } => self.balance(&account).await,
            Op::Sync => self.sync().await,
            Op::Status => self.status(),
            Op::Programs => self.programs().await,
            Op::Transfer {
                from,
                to,
                to_private,
                amount,
            } => {
                self.transfer(&from, to.as_deref(), to_private, amount)
                    .await
            }
            Op::ProgramCall {
                program,
                instruction_data_hex,
                accounts,
                payer,
            } => {
                self.program_call(&program, &instruction_data_hex, &accounts, payer.as_deref())
                    .await
            }
            Op::FaucetInfo => self.faucet_info().await,
            Op::FaucetClaim { account } => self.faucet_claim(&account).await,
            Op::DeployProgram { elf_b64 } => self.deploy_program(&elf_b64).await,
            Op::StorageUpload {
                node_url,
                data_b64,
                filename,
            } => self.storage_upload(&node_url, &data_b64, &filename).await,
            Op::StorageDownload { node_url, cid } => {
                self.storage_download(&node_url, &cid).await
            }
            Op::RegistryLookup { program, registry } => {
                self.registry_lookup(&program, registry.as_deref()).await
            }
            Op::AccountRead { account } => self.account_read(&account).await,
            Op::ExportViewingKey { account } => self.export_viewing_key(&account),
        }
    }

    // ── Vault lifecycle ─────────────────────────────────────────────────

    async fn init(&mut self, password: Option<String>, zone_sel: Option<&str>) -> Result<Output> {
        let zone = zone::resolve(zone_sel)?;
        let dir = TempDir::new()?;
        let paths = Paths::in_dir(dir.path());
        let (core, mnemonic) = WalletCore::new_init_storage(
            paths.config.clone(),
            paths.storage.clone(),
            paths.statistics.clone(),
            zone::config_overrides(&zone),
            password.as_deref().unwrap_or(""),
        )
        .await?;
        core.store_persistent_data()?;
        let blob_b64 = read_blob(&paths.storage)?;
        self.session = Some(Session {
            core,
            storage_path: paths.storage,
            zone,
            _dir: dir,
        });
        Ok(Output::Initialized {
            mnemonic: mnemonic.to_string(),
            blob_b64,
        })
    }

    async fn restore(
        &mut self,
        mnemonic: &str,
        password: Option<String>,
        zone_sel: Option<&str>,
    ) -> Result<Output> {
        let zone = zone::resolve(zone_sel)?;
        let dir = TempDir::new()?;
        let paths = Paths::in_dir(dir.path());
        // Start from a fresh storage so WalletCore constructs cleanly, then
        // restore the seed over it.
        let (mut core, _fresh) = WalletCore::new_init_storage(
            paths.config.clone(),
            paths.storage.clone(),
            paths.statistics.clone(),
            zone::config_overrides(&zone),
            "",
        )
        .await?;
        let mnemonic = Mnemonic::from_str(mnemonic.trim()).context("invalid mnemonic")?;
        core.restore_storage(&mnemonic, password.as_deref().unwrap_or(""))?;
        core.store_persistent_data()?;
        let blob_b64 = read_blob(&paths.storage)?;
        self.session = Some(Session {
            core,
            storage_path: paths.storage,
            zone,
            _dir: dir,
        });
        Ok(Output::Restored { blob_b64 })
    }

    async fn unlock(&mut self, blob_b64: &str, zone_sel: Option<&str>) -> Result<Output> {
        let zone = zone::resolve(zone_sel)?;
        let blob = base64::engine::general_purpose::STANDARD
            .decode(blob_b64)
            .context("blob is not valid base64")?;
        let dir = TempDir::new()?;
        let paths = Paths::in_dir(dir.path());
        std::fs::write(&paths.storage, &blob).context("failed to materialize storage")?;
        let core = WalletCore::new_update_chain(
            paths.config,
            paths.storage.clone(),
            paths.statistics,
            zone::config_overrides(&zone),
        )
        .await
        .context("failed to open wallet from blob")?;
        self.session = Some(Session {
            core,
            storage_path: paths.storage,
            zone,
            _dir: dir,
        });
        Ok(Output::Unlocked)
    }

    fn export_blob(&mut self) -> Result<Output> {
        let s = self.session_mut()?;
        s.core.store_persistent_data()?;
        Ok(Output::Blob {
            blob_b64: read_blob(&s.storage_path)?,
        })
    }

    // ── Accounts ─────────────────────────────────────────────────────────

    fn create_account(&mut self, label: &str, private: bool) -> Result<Output> {
        let s = self.session_mut()?;
        let label = Label::from(label);
        s.core.storage().check_label_availability(&label)?;
        let (account_id, _chain_index) = if private {
            s.core.create_new_account_private(None)
        } else {
            s.core.create_new_account_public(None)
        };
        let id_with_privacy = if private {
            AccountIdWithPrivacy::Private(account_id)
        } else {
            AccountIdWithPrivacy::Public(account_id)
        };
        s.core.storage_mut().add_label(label, id_with_privacy)?;
        s.core.store_persistent_data()?;
        Ok(Output::Account {
            account_id: id_with_privacy.to_string(),
        })
    }

    fn list_accounts(&mut self) -> Result<Output> {
        let s = self.session_mut()?;
        let mut accounts = Vec::new();
        for (account_id, _chain_index) in s.core.storage().key_chain().account_ids() {
            let mut labeled = false;
            for label in s.core.storage().labels_for_account(account_id) {
                labeled = true;
                accounts.push(AccountEntry {
                    label: label.to_string(),
                    account_id: account_id.to_string(),
                });
            }
            if !labeled {
                accounts.push(AccountEntry {
                    label: String::new(),
                    account_id: account_id.to_string(),
                });
            }
        }
        Ok(Output::Accounts { accounts })
    }

    async fn balance(&mut self, account: &str) -> Result<Output> {
        let s = self.session_mut()?;
        let id = parse_account_id(account)?;
        let balance = match id {
            AccountIdWithPrivacy::Public(acc) => s.core.get_account_balance(acc).await?,
            AccountIdWithPrivacy::Private(acc) => {
                let view = s
                    .core
                    .get_account_private(acc)
                    .context("private account not owned by this wallet")?;
                view.balance
            }
        };
        Ok(Output::Balance { balance })
    }

    async fn sync(&mut self) -> Result<Output> {
        let s = self.session_mut()?;
        let block = s.core.sync_to_latest_block().await?;
        s.core.store_persistent_data()?;
        Ok(Output::Synced { block })
    }

    fn status(&mut self) -> Result<Output> {
        let s = self.session_mut()?;
        Ok(Output::Status {
            sequencer: s.core.helm_url().to_string(),
            zone: s.zone.name.to_string(),
        })
    }

    async fn programs(&mut self) -> Result<Output> {
        let s = self.session_mut()?;
        let programs = s
            .core
            .get_program_ids()
            .await?
            .into_iter()
            .map(|(name, id)| (name, program_id_hex(&id)))
            .collect();
        Ok(Output::Programs { programs })
    }

    // ── Transfers & calls ────────────────────────────────────────────────

    async fn transfer(
        &mut self,
        from: &str,
        to: Option<&str>,
        to_private: Option<crate::op::PrivateDest>,
        amount: u128,
    ) -> Result<Output> {
        let s = self.session_mut()?;
        // Public recipients must be initialized on-chain (owned by the
        // token program) or the sequencer drops the transaction — same
        // rule the faucet enforces. Auto-register owned recipients.
        if let Some(t) = to
            && let Ok(AccountIdWithPrivacy::Public(tid)) = parse_account_id(t)
        {
            match crate::faucet::inspect_recipient(&s.core, tid).await?.0 {
                crate::faucet::Eligibility::Uninitialized => {
                    crate::faucet::register_account(&s.core, tid).await?;
                }
                crate::faucet::Eligibility::WrongOwner => {
                    bail!("recipient is managed by a different program")
                }
                crate::faucet::Eligibility::Eligible => {}
            }
        }
        let ntt = NativeTokenTransfer(&s.core);
        let from_id = parse_account_id(from)?;
        let hash = match (from_id, to.map(parse_account_id).transpose()?, to_private) {
            (AccountIdWithPrivacy::Public(f), Some(AccountIdWithPrivacy::Public(t)), _) => ntt
                .send_public_transfer(
                    AccountIdentity::Public(f),
                    AccountIdentity::PublicNoSign(t),
                    amount,
                )
                .await
                .map_err(|e| anyhow::anyhow!("{e:?}"))?,
            (_, Some(AccountIdWithPrivacy::Private(t)), _) => {
                // Public or private sender shielding into an owned private account.
                let from_identity = account_identity(&s.core, from_id)?;
                let (h, _secret) = ntt
                    .send_shielded_transfer(from_identity, t, amount)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                h
            }
            (AccountIdWithPrivacy::Private(f), Some(AccountIdWithPrivacy::Public(t)), _) => {
                let (h, _secret) = ntt
                    .send_deshielded_transfer(f, t, amount)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                h
            }
            (AccountIdWithPrivacy::Private(f), None, Some(dest)) => {
                let npk = serde_json::from_value(dest.npk).context("bad npk")?;
                let vpk = serde_json::from_value(dest.vpk).context("bad vpk")?;
                let identifier =
                    serde_json::from_value(dest.identifier).context("bad identifier")?;
                let (h, _secrets) = ntt
                    .send_private_transfer_to_outer_account(f, npk, vpk, identifier, amount)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
                h
            }
            (AccountIdWithPrivacy::Private(_), None, None) => {
                bail!("private transfer needs `to` (owned) or `to_private` (foreign)")
            }
            (AccountIdWithPrivacy::Public(_), None, _) => {
                bail!("transfer needs a `to` account")
            }
        };
        s.core.store_persistent_data()?;
        Ok(Output::TxHash {
            hash: hash.to_string(),
        })
    }

    async fn program_call(
        &mut self,
        program: &str,
        instruction_data_hex: &str,
        accounts: &[crate::op::Mention],
        payer: Option<&str>,
    ) -> Result<Output> {
        let s = self.session_mut()?;
        let program_id = parse_program_id(program).context("bad program id")?;
        // Instruction data travels as hex-encoded little-endian u32 words
        // (the RISC Zero serializer format — see sdk/registry risc0.ts).
        let raw = hex::decode(instruction_data_hex).context("bad instruction_data hex")?;
        if raw.len() % 4 != 0 {
            bail!("instruction_data hex must decode to whole u32 words");
        }
        let instruction_data: Vec<u32> = raw
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| u32::from_le_bytes(*c))
            .collect();
        if payer.is_some() {
            tracing::warn!("`payer` ignored: the v0.2 wire protocol has no fee payer field");
        }
        let identities = accounts
            .iter()
            .map(|m| {
                let account_id =
                    parse_bare_account_id(&m.account).context("bad mention account")?;
                account_identity_for(&s.core, account_id)
            })
            .collect::<Result<Vec<_>>>()?;
        let hash = s
            .core
            .send_pub_tx(identities, instruction_data, program_id)
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        s.core.store_persistent_data()?;
        Ok(Output::TxHash {
            hash: hash.to_string(),
        })
    }

    // ── Piñata faucet ────────────────────────────────────────────────────

    async fn faucet_info(&mut self) -> Result<Output> {
        let s = self.session_mut()?;
        let (pool, claims, difficulty, can_claim, blocked) =
            crate::faucet::faucet_info(&s.core).await?;
        Ok(Output::Faucet {
            prize: crate::faucet::PRIZE.to_string(),
            pool_balance: pool.to_string(),
            claims_remaining: claims.to_string(),
            difficulty_bytes: difficulty,
            can_claim,
            blocked_reason: blocked,
        })
    }

    async fn faucet_claim(&mut self, account: &str) -> Result<Output> {
        let s = self.session_mut()?;
        let winner = parse_bare_account_id(account).context("bad recipient account")?;
        let (before, after, tx_hash, retries) = crate::faucet::claim(&s.core, winner).await?;
        Ok(Output::FaucetClaimed {
            account: account.to_string(),
            amount: crate::faucet::PRIZE.to_string(),
            balance_before: before.to_string(),
            balance_after: after.to_string(),
            tx_hash,
            stale_retries: retries,
        })
    }

    // ── Program deployment ───────────────────────────────────────────────

    async fn deploy_program(&mut self, elf_b64: &str) -> Result<Output> {
        let s = self.session_mut()?;
        let elf = base64::engine::general_purpose::STANDARD
            .decode(elf_b64)
            .context("elf_b64 is not valid base64")?;
        // The deployed program id is the RISC Zero image id of the ELF —
        // computed exactly as the sequencer will.
        let program = lee::program::Program::new(std::borrow::Cow::Owned(elf.clone()))
            .map_err(|e| anyhow::anyhow!("invalid program ELF: {e}"))?;
        let program_id = program_id_hex(&program.id());
        let hash = s
            .core
            .send_program_deployment_transaction(elf)
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let (_tx, block_id) = s
            .core
            .poll_transaction(hash)
            .await
            .context("deployment was not included in a block")?;
        s.core.store_persistent_data()?;
        Ok(Output::ProgramDeployed {
            program_id,
            tx_hash: hash.to_string(),
            block_id,
        })
    }

    // ── On-chain registry ────────────────────────────────────────────────

    async fn registry_lookup(&mut self, program: &str, registry: Option<&str>) -> Result<Output> {
        let s = self.session_mut()?;
        let target = parse_program_id(program).context("bad program id")?;
        let reg = match registry {
            Some(r) => parse_program_id(r).context("bad registry program id")?,
            None => crate::registry::program_id_from_hex(crate::registry::REGISTRY_PROGRAM_ID_HEX)?,
        };
        let entry = crate::registry::lookup_deployer_entry(&s.core, &reg, &target).await?;
        Ok(Output::RegistryEntry { entry })
    }

    async fn account_read(&mut self, account: &str) -> Result<Output> {
        let s = self.session_mut()?;
        let id = parse_bare_account_id(account).context("bad account id")?;
        let acc = s.core.get_account_public(id).await?;
        Ok(Output::AccountData {
            data_b64: base64::engine::general_purpose::STANDARD.encode(acc.data.as_ref()),
            program_owner: acc
                .program_owner
                .iter()
                .flat_map(|w| w.to_le_bytes())
                .map(|b| format!("{b:02x}"))
                .collect(),
            balance: acc.balance.to_string(),
            nonce: acc.nonce.0 as u64,
        })
    }


    /// Export viewing material for a private account so client-side wasm
    /// codecs can scan/decrypt notes. Never returns spending keys.
    fn export_viewing_key(&mut self, account: &str) -> Result<Output> {
        let s = self.session_mut()?;
        let id = parse_bare_account_id(account).context("bad account id")?;
        for (account_id, key_chain, _chain_index) in
            s.core.storage().key_chain().private_account_key_chains()
        {
            if account_id != id {
                continue;
            }
            let vsk = &key_chain.private_key_holder.viewing_secret_key;
            return Ok(Output::ViewingKey {
                account: account_id.to_string(),
                npk_hex: hex::encode(key_chain.nullifier_public_key.to_byte_array()),
                vpk_hex: hex::encode(key_chain.viewing_public_key.to_bytes()),
                d_hex: hex::encode(vsk.d),
                z_hex: hex::encode(vsk.z),
            });
        }
        bail!("no private key chain for {account}")
    }

    // ── Logos Storage ────────────────────────────────────────────────────

    async fn storage_upload(
        &mut self,
        node_url: &str,
        data_b64: &str,
        filename: &str,
    ) -> Result<Output> {
        // Uploads do not need an unlocked vault — ciphertext is opaque.
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .context("data_b64 is not valid base64")?;
        let client = crate::storage::StorageClient::connect(node_url).await?;
        let cid = client.upload(bytes, filename).await?;
        Ok(Output::StorageCid { cid })
    }

    async fn storage_download(&mut self, node_url: &str, cid: &str) -> Result<Output> {
        let client = crate::storage::StorageClient::connect(node_url).await?;
        let bytes = client.network_download(cid).await?;
        Ok(Output::StorageData {
            data_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }

    // ── helpers ──────────────────────────────────────────────────────────

    fn session_mut(&mut self) -> Result<&mut Session> {
        self.session
            .as_mut()
            .context("wallet locked — call unlock first")
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.session = None;
    }
}

struct Paths {
    config: PathBuf,
    storage: PathBuf,
    statistics: PathBuf,
}

impl Paths {
    fn in_dir(dir: &std::path::Path) -> Self {
        Self {
            config: dir.join("config.toml"),
            storage: dir.join("storage.json"),
            statistics: dir.join("statistics.json"),
        }
    }
}

fn read_blob(storage_path: &std::path::Path) -> Result<String> {
    let bytes = std::fs::read(storage_path)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn parse_account_id(s: &str) -> Result<AccountIdWithPrivacy> {
    AccountIdWithPrivacy::from_str(s).map_err(|e| anyhow::anyhow!("{e}"))
}

/// Bare `AccountId` parse that also accepts the `Public/`/`Private/`-prefixed
/// wire form — the prefix only selects privacy presentation; the id is the
/// same account either way.
fn parse_bare_account_id(s: &str) -> Result<lee::AccountId> {
    let bare = s
        .strip_prefix("Public/")
        .or_else(|| s.strip_prefix("Private/"))
        .unwrap_or(s);
    lee::AccountId::from_str(bare).map_err(|e| anyhow::anyhow!("{e}"))
}

fn account_identity(core: &WalletCore, id: AccountIdWithPrivacy) -> Result<AccountIdentity> {
    match id {
        AccountIdWithPrivacy::Public(a) => Ok(AccountIdentity::Public(a)),
        AccountIdWithPrivacy::Private(a) => core
            .resolve_private_account(a)
            .context("private account not owned by this wallet"),
    }
}

fn account_identity_for(core: &WalletCore, account_id: lee::AccountId) -> Result<AccountIdentity> {
    // Prefer a private owned account with that id; for public accounts sign
    // only when the wallet actually holds the key — foreign mentions must be
    // PublicNoSign or `send_pub_tx` fails collecting signatures.
    if let Some(identity) = core.resolve_private_account(account_id) {
        return Ok(identity);
    }
    Ok(if core.get_account_public_signing_key(account_id).is_some() {
        AccountIdentity::Public(account_id)
    } else {
        AccountIdentity::PublicNoSign(account_id)
    })
}

fn parse_program_id(s: &str) -> Result<lee::ProgramId> {
    let bare = s
        .strip_prefix("Public/")
        .or_else(|| s.strip_prefix("Private/"))
        .unwrap_or(s);
    // Canonical form: 64 hex chars — 8 little-endian u32 words of the image id.
    if bare.len() == 64 && bare.chars().all(|c| c.is_ascii_hexdigit()) {
        let mut id = [0u32; 8];
        for (i, w) in id.iter_mut().enumerate() {
            *w = u32::from_str_radix(&bare[i * 8..i * 8 + 8], 16).map(u32::swap_bytes)?;
        }
        return Ok(id);
    }
    bail!("program id must be the 64-hex-char image id, got '{s}'")
}

fn program_id_hex(id: &lee::ProgramId) -> String {
    id.iter()
        .flat_map(|w| w.to_le_bytes())
        .map(|b| format!("{b:02x}"))
        .collect()
}
