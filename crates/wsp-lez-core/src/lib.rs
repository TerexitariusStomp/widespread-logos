//! wsp-lez-core — the shared Widespread LEZ wallet worker.
//!
//! One protocol, three transports:
//!   * `wsp-lezd` — browser-extension native-messaging host
//!   * `widespread_wallet` — LogosCore cdylib module
//!   * `wsp-lez` — CLI
//!
//! The wire contract is `execute(op, wallet_blob) -> (result, wallet_blob')`
//! where `wallet_blob` is the upstream `PersistentStorage` serialization —
//! the payload the client-side sealed vault encrypts at rest.

pub mod faucet;
pub mod op;
pub mod registry;
pub mod storage;
pub mod worker;
pub mod zone;

pub use op::{AccountEntry, Mention, Op, Output, PROTOCOL_VERSION, PrivateDest};
pub use worker::Worker;
pub use zone::{ZoneId, ZoneSpec};

#[cfg(test)]
mod tests {
    use super::*;

    fn worker() -> Worker {
        Worker::new().expect("worker")
    }

    #[test]
    fn op_wire_roundtrip() {
        let op = Op::Transfer {
            from: "Public/abc".into(),
            to: Some("Private/xyz".into()),
            to_private: None,
            amount: 150,
        };
        let bytes = serde_json::to_vec(&op).unwrap();
        let back: Op = serde_json::from_slice(&bytes).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["op"], "transfer");
        assert!(matches!(back, Op::Transfer { amount: 150, .. }));
    }

    #[test]
    fn init_create_export_unlock_roundtrip() {
        // The sealed-vault contract: state serializes out as a blob and
        // restores with accounts intact — exercised offline (no chain calls).
        let mut w = worker();
        let Output::Initialized { .. } = w.execute(Op::Init { password: None, zone: None }).unwrap() else {
            panic!("init failed")
        };
        w.execute(Op::CreateAccount {
            label: "main".into(),
            private: false,
        })
        .unwrap();
        w.execute(Op::CreateAccount {
            label: "savings".into(),
            private: true,
        })
        .unwrap();
        let Output::Blob { blob_b64: exported } = w.execute(Op::ExportBlob).unwrap() else {
            panic!("export failed")
        };

        // New worker, unlock from the blob — labels and ids must survive.
        let mut w2 = worker();
        w2.execute(Op::Unlock { blob_b64: exported, zone: None }).unwrap();
        let Output::Accounts { accounts } = w2.execute(Op::ListAccounts).unwrap() else {
            panic!("list failed")
        };
        let labels: Vec<_> = accounts.iter().map(|a| a.label.as_str()).collect();
        assert!(
            labels.contains(&"main"),
            "missing labeled account: {labels:?}"
        );
        assert!(labels.contains(&"savings"));
        assert!(
            accounts
                .iter()
                .any(|a| a.account_id.starts_with("Private/"))
        );
    }

    #[test]
    fn locked_session_rejects_ops() {
        let mut w = worker();
        let err = w.execute(Op::ListAccounts).unwrap_err();
        assert!(
            err.to_string().contains("unlock"),
            "unexpected error: {err}"
        );
    }
}
