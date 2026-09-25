//! Logos Storage (Codex) REST client — native side.
//!
//! Same contract as `@widespread/storage-client` (which wraps
//! `@codex-storage/sdk-js`): opaque ciphertext bytes in, CID out. Used by
//! the CLI/native surfaces for vault-blob backup and registry artifact
//! mirroring. Widespread runs no storage gateway — `node_url` points at a
//! Codex node the user runs (local or their own remote node).
//!
//! The REST surface is versioned: current logos-storage nodes serve
//! `/api/storage/v1`, older codex nodes `/api/codex/v1`. We probe once and
//! cache the working prefix.

use std::time::Duration;

use anyhow::{Context, Result, bail};

const PREFIXES: [&str; 2] = ["/api/storage/v1", "/api/codex/v1"];
const TIMEOUT: Duration = Duration::from_secs(60);

pub struct StorageClient {
    http: reqwest::Client,
    base: String,
    prefix: String,
}

impl StorageClient {
    /// Connect to a node and detect which REST prefix it serves.
    pub async fn connect(node_url: &str) -> Result<Self> {
        let base = node_url.trim_end_matches('/').to_string();
        let http = reqwest::Client::builder().timeout(TIMEOUT).build()?;
        for prefix in PREFIXES {
            let res = http
                .get(format!("{base}{prefix}/space"))
                .send()
                .await;
            match res {
                Ok(r) if r.status().is_success() || r.status().as_u16() == 401 => {
                    return Ok(Self {
                        http,
                        base,
                        prefix: prefix.to_string(),
                    });
                }
                _ => continue,
            }
        }
        bail!(
            "no Codex storage API at {base} (tried {})",
            PREFIXES.join(", ")
        )
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}{}", self.base, self.prefix, path)
    }

    /// Upload bytes → CID. Raw-body POST to `/data` with
    /// `Content-Disposition: attachment; filename=…` (the node's upload
    /// surface is not multipart — see codex OpenAPI `/data` POST).
    pub async fn upload(&self, bytes: Vec<u8>, filename: &str) -> Result<String> {
        let res = self
            .http
            .post(self.url("/data"))
            .header("Content-Type", "application/octet-stream")
            .header(
                "Content-Disposition",
                format!("attachment; filename=\"{filename}\""),
            )
            .body(bytes)
            .send()
            .await
            .context("upload request failed")?;
        if !res.status().is_success() {
            bail!("upload failed: HTTP {}", res.status());
        }
        Ok(res.text().await?.trim().to_string())
    }

    /// Bytes the node already holds locally.
    pub async fn local_download(&self, cid: &str) -> Result<Vec<u8>> {
        let res = self
            .http
            .get(self.url(&format!("/data/{cid}")))
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("local download failed for {cid}: HTTP {}", res.status());
        }
        Ok(res.bytes().await?.to_vec())
    }

    /// Pull the CID from the network into the local node, then read it back.
    pub async fn network_download(&self, cid: &str) -> Result<Vec<u8>> {
        let res = self
            .http
            .get(self.url(&format!("/data/{cid}/network/stream")))
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("network download failed for {cid}: HTTP {}", res.status());
        }
        Ok(res.bytes().await?.to_vec())
    }

    /// Dataset manifest for a CID (codec, block size, dataset size).
    pub async fn manifest(&self, cid: &str) -> Result<serde_json::Value> {
        let res = self
            .http
            .get(self.url(&format!("/data/{cid}/network/manifest")))
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("manifest fetch failed for {cid}: HTTP {}", res.status());
        }
        Ok(res.json().await?)
    }
}
