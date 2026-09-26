//! BIP-39 mnemonic → LEZ key derivation — a byte-parity port of the upstream
//! `key_protocol` HD tree (`lee/key_protocol/src/key_management/` in
//! logos-execution-zone), which cannot be compiled to wasm32 (its `common`
//! dep pulls the HTTP client stack).
//!
//! Only the *viewing-side* material crosses the wasm boundary: public-account
//! ids/public keys and private-account viewing keys (npk/vpk/d/z). The
//! nullifier secret key never leaves this module — spending stays behind
//! `wsp-lezd`, matching the facade's stated trust boundary.
//!
//! Parity is enforced by `keys_parity` tests, which diff every byte against
//! the real wallet through `wsp-lez-ffi`.
//!
//! Layout (upstream):
//!   seed64  = bip39.to_seed("")
//!   private root: hmac64(seed64, "LEE_master_priv") → (ssk, ccc)
//!   public  root: hmac64(seed64, "LEE_master_pub")  → (sk,  cc)
//!   child cci:  priv: hmac64("LEE_seed_priv" || parent_pt || cci_be, ccc)
//!               pub:  hmac64([0] || sk || cci_be, cc); sk += delta (k256 scalar)
//!   per node:   nsk = sha256("LEE/keys" || ssk || [1] || index_be || 0^19)
//!               npk = sha256("LEE/keys" || nsk || [7] || 0^23)
//!               vsk = hmac64("LEE/keys" || ssk || [2] || index_be || 0^19,
//!                            "LEE_viewing_seed") → (d, z)
//!               vpk = ML-KEM-768 encapsulation key from seed (d||z)
//!   ids:        pub  = sha256("/LEE/v0.3/AccountId/Public/\x00*5" || pk_x32)
//!               priv = AccountId::for_regular_private_account(npk, vpk, ident)

use bip39::Mnemonic;
use hmac_sha512::HMAC;
use k256::elliptic_curve::{sec1::ToEncodedPoint as _, PrimeField as _};
use lee_core::{
    account::AccountId,
    encryption::{ViewingPublicKey, shared_key_derivation::MlKem768EncapsulationKey},
    NullifierPublicKey,
};
use sha2::Digest as _;
use std::str::FromStr as _;

const KEYS_PREFIX: &[u8; 8] = b"LEE/keys";
const PUBLIC_ACCOUNT_ID_PREFIX: &[u8; 32] = b"/LEE/v0.3/AccountId/Public/\x00\x00\x00\x00\x00";

fn hmac64(data: &[u8], key: &[u8]) -> [u8; 64] {
    HMAC::mac(data, key)
}

fn split_hash(hash: &[u8; 64]) -> ([u8; 32], [u8; 32]) {
    (*hash.first_chunk::<32>().unwrap(), *hash.last_chunk::<32>().unwrap())
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = sha2::Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

struct PrivateNode {
    ssk: [u8; 32],
    ccc: [u8; 32],
    cci: Option<u32>,
}

struct PublicNode {
    sk: [u8; 32],
    cc: [u8; 32],
}

impl PrivateNode {
    fn root(seed: &[u8; 64]) -> Self {
        let (ssk, ccc) = split_hash(&hmac64(seed, b"LEE_master_priv"));
        Self { ssk, ccc, cci: None }
    }

    fn nth_child(&self, cci: u32) -> Self {
        let nsk = self.nullifier_secret_key();
        let vsk = self.viewing_secret_key();
        let parent_pt = sha256(&[KEYS_PREFIX, &nsk, &vsk.0, &vsk.1]);
        let mut input = Vec::with_capacity(13 + 32 + 4);
        input.extend_from_slice(b"LEE_seed_priv");
        input.extend_from_slice(&parent_pt);
        input.extend_from_slice(&cci.to_be_bytes());
        let (ssk, ccc) = split_hash(&hmac64(&input, &self.ccc));
        Self { ssk, ccc, cci: Some(cci) }
    }

    fn nullifier_secret_key(&self) -> [u8; 32] {
        sha256(&[
            KEYS_PREFIX,
            &self.ssk,
            &[1],
            &self.cci.unwrap_or(0).to_be_bytes(),
            &[0; 19],
        ])
    }

    /// (d, z) — FIPS-203 seed halves.
    fn viewing_secret_key(&self) -> ([u8; 32], [u8; 32]) {
        let mut bytes = Vec::with_capacity(64);
        bytes.extend_from_slice(KEYS_PREFIX);
        bytes.extend_from_slice(&self.ssk);
        bytes.extend_from_slice(&[2]);
        bytes.extend_from_slice(&self.cci.unwrap_or(0).to_be_bytes());
        bytes.extend_from_slice(&[0; 19]);
        let seed = hmac64(&bytes, b"LEE_viewing_seed");
        split_hash(&seed)
    }

    fn nullifier_public_key(&self) -> NullifierPublicKey {
        NullifierPublicKey::from(&self.nullifier_secret_key())
    }

    fn viewing_public_key(&self) -> ViewingPublicKey {
        let (d, z) = self.viewing_secret_key();
        // `ViewingSecretKey{d,z}` → `ViewingPublicKey` is
        // `MlKem768::DecapsulationKey::from_seed(d||z).encapsulation_key()`;
        // lee_core exposes the same constructor as from_seed(&d,&z)
        // (ViewingPublicKey is a type alias of MlKem768EncapsulationKey).
        MlKem768EncapsulationKey::from_seed(&d, &z)
    }
}

impl PublicNode {
    fn root(seed: &[u8; 64]) -> Self {
        let (sk, cc) = split_hash(&hmac64(seed, b"LEE_master_pub"));
        let sk = valid_scalar(sk);
        Self { sk, cc }
    }

    fn nth_child(&self, cci: u32) -> Self {
        let mut input = Vec::with_capacity(1 + 32 + 4);
        input.push(0u8);
        input.extend_from_slice(&self.sk);
        input.extend_from_slice(&cci.to_be_bytes());
        let (delta, cc) = split_hash(&hmac64(&input, &self.cc));
        // child sk = parent sk + delta (mod curve order)
        let lhs = k256::Scalar::from_repr(delta.into()).expect("valid scalar");
        let rhs = k256::Scalar::from_repr(self.sk.into()).expect("valid scalar");
        let sk = valid_scalar((lhs + rhs).to_bytes().into());
        Self { sk, cc }
    }

    /// `lee::PrivateKey::tweak`: ssk = sk + sha256(compressed_pk(sk)) (BIP-340-style
    /// quantum-shield tweak for the Schnorr signing key).
    fn tweaked_signing_key(&self) -> k256::SecretKey {
        let sk = k256::SecretKey::from_slice(&self.sk).expect("valid key");
        let tweak: [u8; 32] =
            sha256(&[sk.public_key().to_encoded_point(true).as_bytes()]);
        let tweak_scalar = k256::Scalar::from_repr(tweak.into())
            .into_option()
            .expect("valid tweak scalar");
        let tweaked = (*sk.to_nonzero_scalar() + tweak_scalar).to_bytes();
        k256::SecretKey::from_slice(&tweaked).expect("tweaked key is valid")
    }

    /// x-only BIP-340 public key of the tweaked signing key.
    fn public_key_x(&self) -> [u8; 32] {
        let ssk = self.tweaked_signing_key();
        let encoded = ssk.public_key().to_encoded_point(false);
        *encoded.x().expect("x coord").first_chunk().unwrap()
    }

    fn account_id(&self) -> AccountId {
        AccountId::new(sha256(&[PUBLIC_ACCOUNT_ID_PREFIX, &self.public_key_x()]))
    }
}

fn valid_scalar(bytes: [u8; 32]) -> [u8; 32] {
    // lee::PrivateKey::try_new rejects 0 and >= curve-order values; replicate.
    k256::SecretKey::from_slice(&bytes)
        .map(|_| bytes)
        .expect("hash-derived key must be a valid secp256k1 scalar")
}

fn seed_from_mnemonic(mnemonic: &str) -> Option<[u8; 64]> {
    let m = Mnemonic::from_str(mnemonic.trim()).ok()?;
    Some(m.to_seed(""))
}

fn walk_private(seed: &[u8; 64], path: &[u32]) -> PrivateNode {
    path.iter().fold(PrivateNode::root(seed), |n, &c| n.nth_child(c))
}

fn walk_public(seed: &[u8; 64], path: &[u32]) -> PublicNode {
    path.iter().fold(PublicNode::root(seed), |n, &c| n.nth_child(c))
}

/// Private-account viewing bundle: account id + keys needed to scan/decrypt
/// outputs (npk, vpk, and the FIPS-203 seed halves d/z — the same material
/// `wsp-lez-core::ExportViewingKey` hands to wasm codecs). `path` is the HD
/// chain index of the account node (the wallet's first private account is
/// `[0]`); `identifier` is the u128 receiver diversifier (default "0").
pub(crate) fn private_account_json(
    mnemonic: &str,
    path: &[u32],
    identifier: u128,
) -> Option<String> {
    let seed = seed_from_mnemonic(mnemonic)?;
    let node = walk_private(&seed, path);
    let npk = node.nullifier_public_key();
    let vpk = node.viewing_public_key();
    let (d, z) = node.viewing_secret_key();
    let account_id = AccountId::for_regular_private_account(&npk, &vpk, identifier);
    serde_json::json!({
        "account_id": account_id.to_string(),
        "npk": hex::encode(npk.0),
        "vpk": hex::encode(vpk.to_bytes()),
        "d": hex::encode(d),
        "z": hex::encode(z),
    })
    .to_string()
    .into()
}

/// Public-account identity: account id + the x-only BIP-340 public key.
/// Returns no secret material.
pub(crate) fn public_account_json(mnemonic: &str, path: &[u32]) -> Option<String> {
    let seed = seed_from_mnemonic(mnemonic)?;
    let node = walk_public(&seed, path);
    serde_json::json!({
        "account_id": node.account_id().to_string(),
        "pk_x": hex::encode(node.public_key_x()),
    })
    .to_string()
    .into()
}
