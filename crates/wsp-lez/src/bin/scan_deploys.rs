//! One-shot: scan a block range for ProgramDeployment txs — recovers v3
//! deploy provenance (tx hash, block, program id) for ARTIFACTS.md.

use base64::Engine as _;
use borsh::BorshDeserialize as _;
use common::block::Block;
use common::transaction::LeeTransaction;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    for height in 23499u64..=23600 {
        let resp: serde_json::Value = client
            .post("https://testnet.lez.logos.co")
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "getBlock", "params": [height]
            }))
            .send().await?.json().await?;
        let Some(b64) = resp["result"].as_str() else { continue };
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64)?;
        let Ok(block) = Block::try_from_slice(&bytes) else { continue };
        for tx in block.body.transactions {
            let hash = tx.hash();
            if let LeeTransaction::ProgramDeployment(d) = tx {
                let bytecode = d.into_message().into_bytecode();
                let pid = lee::program::Program::new(std::borrow::Cow::Owned(bytecode))
                    .map(|p| p.id())
                    .unwrap_or_default();
                let hex_pid: String = pid.iter()
                    .flat_map(|w| w.to_le_bytes())
                    .map(|b| format!("{b:02x}")).collect();
                println!("block {height} deploy tx {hash} program {hex_pid}");
            }
        }
    }
    Ok(())
}
