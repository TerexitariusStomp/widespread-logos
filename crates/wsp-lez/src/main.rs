//! wsp-lez — Widespread LEZ wallet CLI.
//!
//! Thin client over `wsp_lez_core::Worker`. Vault state is a blob file
//! (`--vault`, default `~/.wsp-lez/vault.blob`); the file contents are the
//! upstream `PersistentStorage` serialization — the same payload the
//! extension/module seal inside their vault envelopes.

use std::path::PathBuf;

use anyhow::{Context, Result};
use base64::Engine as _;
use clap::{Parser, Subcommand};
use wsp_lez_core::{Mention, Op, Output, Worker};

#[derive(Parser)]
#[command(name = "wsp-lez", about = "Widespread LEZ wallet CLI", version)]
struct Cli {
    /// Path to the vault blob file.
    #[arg(long, global = true, default_value = "~/.wsp-lez/vault.blob")]
    vault: String,
    /// Zone selector (LP-0022): 'lez' (default) or a sequencer URL for a
    /// custom zone (standalone sequencer / devnet).
    #[arg(long, global = true)]
    zone: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create a fresh vault (prints the mnemonic once).
    Init {
        #[arg(long)]
        password: Option<String>,
    },
    /// Restore a vault from a mnemonic.
    Restore {
        #[arg(long)]
        mnemonic: String,
        #[arg(long)]
        password: Option<String>,
    },
    /// Create an account in the vault.
    NewAccount {
        label: String,
        #[arg(long)]
        private: bool,
    },
    /// List accounts.
    Accounts,
    /// Account balance: Public/<id> or Private/<id>.
    Balance { account: String },
    /// Sync wallet state to the latest block.
    Sync,
    /// Sequencer/status info.
    Status,
    /// Known program ids on the zone.
    Programs,
    /// Native-token transfer. `to` for owned accounts, or `--to-npk/--to-vpk/--to-id`
    /// (JSON) for a foreign private destination.
    Transfer {
        from: String,
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        to_npk: Option<String>,
        #[arg(long)]
        to_vpk: Option<String>,
        #[arg(long)]
        to_id: Option<String>,
        amount: u128,
    },
    /// Generic public program call. `program` is the 64-hex image id.
    Call {
        program: String,
        #[arg(long)]
        data: String,
        #[arg(long, value_parser = parse_mention)]
        account: Vec<Mention>,
        #[arg(long)]
        payer: Option<String>,
    },
    /// Faucet status: pool depth, difficulty, eligibility.
    FaucetInfo,
    /// Claim one faucet drop (solves the live PoW challenge).
    FaucetClaim { account: String },
    /// Deploy a program ELF to the zone; prints the on-chain program id.
    Deploy { elf: String },
    /// Upload a file to a Logos Storage node → prints the CID.
    StorageUpload {
        file: String,
        #[arg(long, default_value = "http://localhost:8080")]
        node: String,
    },
    /// Download a CID from a Logos Storage node → writes the file.
    StorageDownload {
        cid: String,
        #[arg(long, default_value = "http://localhost:8080")]
        node: String,
        #[arg(long, short)]
        out: String,
    },
    /// Upload the sealed vault blob to Logos Storage → prints the CID.
    VaultUpload {
        #[arg(long, default_value = "http://localhost:8080")]
        node: String,
    },
    /// Fetch a vault blob from Logos Storage and store it as the vault.
    VaultDownload {
        cid: String,
        #[arg(long, default_value = "http://localhost:8080")]
        node: String,
    },
    /// Look up a program's deployer entry in the on-chain registry.
    RegistryLookup { program: String },
}

fn parse_mention(s: &str) -> Result<Mention, String> {
    // "account" or "account@program_account_id" (the @shard part is a v0.3
    // concept and ignored on the v0.2 wire).
    let (account, program_account_id) = match s.split_once('@') {
        Some((a, p)) => (a.to_string(), Some(p.to_string())),
        None => (s.to_string(), None),
    };
    Ok(Mention { account, program_account_id })
}

fn vault_path(arg: &str) -> PathBuf {
    PathBuf::from(shellexpand(arg))
}

fn shellexpand(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/")
        && let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    p.to_string()
}

fn load_blob(path: &PathBuf) -> Result<String> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("no vault at {} — run `wsp-lez init` first", path.display()))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn store_blob(path: &PathBuf, blob_b64: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(blob_b64)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

fn print_output(out: &Output) {
    println!("{}", serde_json::to_string_pretty(out).unwrap());
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let vault = vault_path(&cli.vault);
    let mut worker = Worker::new()?;

    match cli.cmd {
        Cmd::Init { password } => {
            let out = worker.execute(Op::Init {
                password,
                zone: cli.zone.clone(),
            })?;
            if let Output::Initialized { blob_b64, .. } = &out {
                store_blob(&vault, blob_b64)?;
            }
            print_output(&out);
        }
        Cmd::Restore { mnemonic, password } => {
            let out = worker.execute(Op::Restore {
                mnemonic,
                password,
                zone: cli.zone.clone(),
            })?;
            if let Output::Restored { blob_b64 } = &out {
                store_blob(&vault, blob_b64)?;
            }
            print_output(&out);
        }
        Cmd::StorageUpload { file, node } => {
            let bytes = std::fs::read(&file)
                .with_context(|| format!("cannot read {file}"))?;
            let filename = std::path::Path::new(&file)
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_else(|| "blob".to_string());
            let out = worker.execute(Op::StorageUpload {
                node_url: node,
                data_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
                filename,
            })?;
            print_output(&out);
        }
        Cmd::StorageDownload { cid, node, out } => {
            let res = worker.execute(Op::StorageDownload {
                node_url: node,
                cid,
            })?;
            if let Output::StorageData { data_b64 } = &res {
                let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64)?;
                std::fs::write(&out, bytes)?;
            }
            print_output(&res);
        }
        Cmd::VaultDownload { cid, node } => {
            let res = worker.execute(Op::StorageDownload {
                node_url: node,
                cid,
            })?;
            if let Output::StorageData { data_b64 } = &res {
                store_blob(&vault, data_b64)?;
            }
            print_output(&res);
        }
        cmd => {
            // Everything else needs the unlocked session.
            worker.execute(Op::Unlock {
                blob_b64: load_blob(&vault)?,
                zone: cli.zone.clone(),
            })?;
            let out = match cmd {
                Cmd::NewAccount { label, private } => {
                    worker.execute(Op::CreateAccount { label, private })?
                }
                Cmd::Accounts => worker.execute(Op::ListAccounts)?,
                Cmd::Balance { account } => worker.execute(Op::Balance { account })?,
                Cmd::Sync => worker.execute(Op::Sync)?,
                Cmd::Status => worker.execute(Op::Status)?,
                Cmd::Programs => worker.execute(Op::Programs)?,
                Cmd::Transfer {
                    from,
                    to,
                    to_npk,
                    to_vpk,
                    to_id,
                    amount,
                } => {
                    let to_private = match (to_npk, to_vpk, to_id) {
                        (Some(npk), Some(vpk), Some(identifier)) => {
                            Some(wsp_lez_core::PrivateDest {
                                npk: serde_json::from_str(&npk).context("bad --to-npk JSON")?,
                                vpk: serde_json::from_str(&vpk).context("bad --to-vpk JSON")?,
                                identifier: serde_json::from_str(&identifier)
                                    .context("bad --to-id JSON")?,
                            })
                        }
                        (None, None, None) => None,
                        _ => anyhow::bail!("--to-npk, --to-vpk and --to-id must be given together"),
                    };
                    worker.execute(Op::Transfer {
                        from,
                        to,
                        to_private,
                        amount,
                    })?
                }
                Cmd::Call {
                    program,
                    data,
                    account,
                    payer,
                } => worker.execute(Op::ProgramCall {
                    program,
                    instruction_data_hex: data,
                    accounts: account,
                    payer,
                })?,
                Cmd::FaucetInfo => worker.execute(Op::FaucetInfo)?,
                Cmd::FaucetClaim { account } => worker.execute(Op::FaucetClaim { account })?,
                Cmd::RegistryLookup { program } => worker.execute(Op::RegistryLookup {
                    program,
                    registry: None,
                })?,
                Cmd::VaultUpload { node } => {
                    let Output::Blob { blob_b64 } = worker.execute(Op::ExportBlob)? else {
                        anyhow::bail!("blob export failed")
                    };
                    let bytes = base64::engine::general_purpose::STANDARD.decode(&blob_b64)?;
                    worker.execute(Op::StorageUpload {
                        node_url: node,
                        data_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
                        filename: "wsp-vault.blob".to_string(),
                    })?
                }
                Cmd::Deploy { elf } => {
                    let bytes = std::fs::read(&elf)
                        .with_context(|| format!("cannot read ELF at {elf}"))?;
                    worker.execute(Op::DeployProgram {
                        elf_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
                    })?
                }
                _ => unreachable!(),
            };
            // Persist post-op state (new accounts, nonces, sync progress).
            if let Output::Blob { blob_b64 } = worker.execute(Op::ExportBlob)? {
                store_blob(&vault, &blob_b64)?;
            }
            print_output(&out);
        }
    }
    Ok(())
}
