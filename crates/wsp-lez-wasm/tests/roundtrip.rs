//! Host-side round-trip for the private-viewing codec: encrypt a note with
//! the upstream EncryptionScheme, serialize the EncryptedAccountData, then
//! run the exported wasm facade path end-to-end.

use lee_core::{
    account::Account,
    encryption::{EncryptedAccountData, EncryptionScheme, SharedSecretKey},
    Nullifier, NullifierPublicKey,
};
use wsp_lez_wasm::*;

fn vpk(
    vpk_hex: &str,
) -> lee_core::encryption::shared_key_derivation::MlKem768EncapsulationKey {
    lee_core::encryption::shared_key_derivation::MlKem768EncapsulationKey::from_bytes(
        hex::decode(vpk_hex).unwrap(),
    )
    .unwrap()
}

#[test]
fn private_output_decrypt_roundtrip() {
    let d = [7u8; 32];
    let z = [9u8; 32];
    let vpk_hex =
        viewing_public_key_from_seed(&hex::encode(d), &hex::encode(z)).expect("vpk");

    let npk = [3u8; 32];
    let account = Account::default();
    let kind = lee_core::PrivateAccountKind::Regular(42);
    let nullifier = Nullifier::for_dummy(&[5u8; 32]);

    // Sender side: encapsulate to the vpk, encrypt the note, wrap in EAD.
    let (ss, epk) = SharedSecretKey::encapsulate(&vpk(&vpk_hex));
    let ct = EncryptionScheme::encrypt(&account, &kind, &ss, &nullifier);
    let ead = EncryptedAccountData::new(ct, &NullifierPublicKey(npk), &vpk(&vpk_hex), epk.clone());
    let ead_hex = hex::encode(borsh::to_vec(&ead).unwrap());

    // Receiver side (the wasm facade path).
    let tag = compute_view_tag(&hex::encode(npk), &vpk_hex).unwrap();
    assert_eq!(tag, ead.view_tag);

    let ss_hex = decapsulate_shared_secret(&hex::encode(d), &hex::encode(z), &hex::encode(&epk.0))
        .expect("ss");
    let out = decrypt_post_state(&ead_hex, &ss_hex, &hex::encode(nullifier.to_byte_array()))
        .expect("decrypt_post_state");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["kind"]["Regular"], 42);

    // The combined scan entry point must agree.
    let out2 = decrypt_private_output(
        &ead_hex,
        &hex::encode(d),
        &hex::encode(z),
        &hex::encode(nullifier.to_byte_array()),
    )
    .expect("decrypt_private_output");
    let v2: serde_json::Value = serde_json::from_str(&out2).unwrap();
    assert_eq!(v2["account"]["nonce"], 0);

    // AccountId derivation for the viewed note.
    let id = private_account_id_b58(
        &hex::encode(npk),
        &vpk_hex,
        &serde_json::to_string(&v["kind"]).unwrap(),
    )
    .expect("account id");
    assert!(id.len() > 40, "base58 account id");

    // Wrong viewing seed → decapsulation fails → skip, not panic.
    let bad = decrypt_private_output(
        &ead_hex,
        &hex::encode([8u8; 32]),
        &hex::encode(z),
        &hex::encode(nullifier.to_byte_array()),
    );
    assert!(bad.is_none());
}
