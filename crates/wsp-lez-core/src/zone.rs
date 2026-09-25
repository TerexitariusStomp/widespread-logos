//! LP-0022 forward design: zone selection.
//!
//! A *zone* is a named LEZ-compatible endpoint set — sequencer list plus
//! capability flags. v1 ships exactly one zone (`lez`, the public
//! testnet); the registry below is the seam where future zones slot in
//! without changing the worker contract: session-init ops carry an
//! optional `zone`, unknown zones are rejected with the known list, and
//! every downstream surface inherits the selection for free because
//! `WalletCore` is constructed per-session with the zone's endpoints.
//!
//! Zone selection is session-scoped, not per-op: a vault blob's accounts
//! live on one zone, and `WalletCore` binds its sequencer endpoints at
//! construction. Switching zones means a new session.

use anyhow::{bail, Result};
use wallet::config::{SequencerConnectionData, WalletConfigOverrides};

/// Stable zone identifiers. `Lez` is the only built-in; custom zones are
/// addressed by URL (see [`resolve`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZoneId {
    /// Logos Execution Zone — public testnet.
    Lez,
    /// A zone named by explicit sequencer URL — standalone sequencers,
    /// local devnets, future zones not yet in the registry.
    Custom,
}

/// What a zone provides. Capability flags let surfaces hide features a
/// zone lacks rather than failing at call time.
pub struct ZoneSpec {
    pub id: ZoneId,
    /// Canonical zone name (what `Status.zone` reports).
    pub name: &'static str,
    /// Sequencer endpoints. `None` = the wallet's upstream default list
    /// (LEZ testnet peers baked into `WalletConfig`).
    pub sequencers: Option<Vec<SequencerConnectionData>>,
    /// Private accounts/transfers available (LEZ privacy stack).
    pub supports_private: bool,
    /// Piñata faucet present (genesis-funded test zones only).
    pub supports_faucet: bool,
}

const LEZ_TESTNET: ZoneSpec = ZoneSpec {
    id: ZoneId::Lez,
    name: "lez",
    sequencers: None,
    supports_private: true,
    supports_faucet: true,
};

fn custom(url: &str) -> Result<ZoneSpec> {
    Ok(ZoneSpec {
        id: ZoneId::Custom,
        name: "custom",
        sequencers: Some(vec![SequencerConnectionData {
            sequencer_addr: url
                .parse()
                .map_err(|_| anyhow::anyhow!("invalid sequencer URL '{url}'"))?,
            basic_auth: None,
        }]),
        supports_private: true,
        supports_faucet: false,
    })
}

/// Resolve a zone selector to its spec.
///
/// - `None` / `"lez"` / `"lez-testnet"` → the LEZ testnet (upstream default
///   endpoints, overridable per-deploy via `WSP_SEQUENCER_URL`).
/// - A URL (`http://…` / `https://…`) → a custom zone targeting that
///   sequencer — the standalone-sequencer e2e and local devnets.
/// - Anything else → error naming the known zones.
pub fn resolve(zone: Option<&str>) -> Result<ZoneSpec> {
    let selector = zone.unwrap_or("lez");
    let mut spec = match selector {
        "lez" | "lez-testnet" => LEZ_TESTNET,
        // An explicit URL always wins — the env override below applies only
        // to the named zone, so callers can pin a custom zone even in e2e
        // environments where the override is set.
        s if s.starts_with("http://") || s.starts_with("https://") => return custom(s),
        other => bail!(
            "unknown zone '{other}' (known: 'lez'; or pass a sequencer URL for a custom zone)"
        ),
    };
    // Deploy-time override: point the named zone at a specific sequencer.
    // Covers the standalone-sequencer e2e and single-node test deployments.
    if let Ok(url) = std::env::var("WSP_SEQUENCER_URL") {
        spec.sequencers = Some(vec![SequencerConnectionData {
            sequencer_addr: url.parse().map_err(|_| {
                anyhow::anyhow!("WSP_SEQUENCER_URL is not a valid URL: '{url}'")
            })?,
            basic_auth: None,
        }]);
    }
    Ok(spec)
}

/// Wallet-core config overrides for a resolved zone (`None` when the zone
/// uses upstream defaults — the override struct is optional per field).
pub fn config_overrides(spec: &ZoneSpec) -> Option<WalletConfigOverrides> {
    spec.sequencers.as_ref().map(|seq| WalletConfigOverrides {
        sequencers: Some(seq.clone()),
        ..Default::default()
    })
}
