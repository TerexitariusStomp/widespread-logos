//! Byte-parity harness: `keys.rs` re-implements the upstream `key_protocol`
//! HD tree, so the test pins it against the REAL wallet stack — restore a
//! vault from a fixed mnemonic in `wsp-lez-core`, let upstream derive the
//! accounts, and diff every field.

use wsp_lez_core::{Op, Output, Worker};
use wsp_lez_wasm::{lez_private_keys_from_mnemonic, lez_public_keys_from_mnemonic};

// Standard BIP-39 test-vector mnemonic (all-"abandon" + "about").
const MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

fn exec(w: &mut Worker, op: Op) -> Output {
    w.execute(op).expect("worker op failed")
}

fn restored() -> Worker {
    let mut w = Worker::new().expect("worker");
    exec(
        &mut w,
        Op::Restore {
            mnemonic: MNEMONIC.to_string(),
            password: None,
            zone: None,
        },
    );
    w
}

#[test]
fn private_account_parity_with_wallet() {
    let mut w = restored();
    // Wallet's first private account: private tree child [0], identifier 0.
    let out = exec(
        &mut w,
        Op::CreateAccount {
            label: "p0".into(),
            private: true,
        },
    );
    let Output::Account { account_id } = out else {
        panic!("expected Output::Account, got {out:?}");
    };
    let bare = account_id
        .strip_prefix("Private/")
        .expect("private account id");

    let vk = exec(
        &mut w,
        Op::ExportViewingKey {
            account: bare.into(),
        },
    );
    let Output::ViewingKey {
        npk_hex,
        vpk_hex,
        d_hex,
        z_hex,
        ..
    } = vk
    else {
        panic!("expected Output::ViewingKey, got {vk:?}");
    };

    let mine: serde_json::Value = serde_json::from_str(
        &lez_private_keys_from_mnemonic(MNEMONIC, "[0]", "0").expect("derivation failed"),
    )
    .unwrap();

    assert_eq!(mine["account_id"].as_str().unwrap(), bare);
    assert_eq!(mine["npk"].as_str().unwrap(), npk_hex);
    assert_eq!(mine["vpk"].as_str().unwrap(), vpk_hex);
    assert_eq!(mine["d"].as_str().unwrap(), d_hex);
    assert_eq!(mine["z"].as_str().unwrap(), z_hex);
}

#[test]
fn public_account_parity_with_wallet() {
    let mut w = restored();
    // Wallet's first public account: public tree child [0].
    let out = exec(
        &mut w,
        Op::CreateAccount {
            label: "pub0".into(),
            private: false,
        },
    );
    let Output::Account { account_id } = out else {
        panic!("expected Output::Account, got {out:?}");
    };
    let bare = account_id
        .strip_prefix("Public/")
        .expect("public account id");

    let mine: serde_json::Value = serde_json::from_str(
        &lez_public_keys_from_mnemonic(MNEMONIC, "[0]").expect("derivation failed"),
    )
    .unwrap();

    assert_eq!(mine["account_id"].as_str().unwrap(), bare);
    // pk_x is 64 hex chars (x-only BIP-340 key).
    assert_eq!(mine["pk_x"].as_str().unwrap().len(), 64);
}

#[test]
fn deeper_child_differs() {
    // Second layered private account is root child [1] — keys must differ.
    let a = lez_private_keys_from_mnemonic(MNEMONIC, "[0]", "0").unwrap();
    let b = lez_private_keys_from_mnemonic(MNEMONIC, "[1]", "0").unwrap();
    assert_ne!(a, b);
}

#[test]
fn rejects_bad_inputs() {
    assert!(lez_private_keys_from_mnemonic("not a mnemonic", "[0]", "0").is_none());
    assert!(lez_private_keys_from_mnemonic(MNEMONIC, "junk", "0").is_none());
    assert!(lez_private_keys_from_mnemonic(MNEMONIC, "[0]", "nan").is_none());
    assert!(lez_public_keys_from_mnemonic(MNEMONIC, "{}").is_none());
}
