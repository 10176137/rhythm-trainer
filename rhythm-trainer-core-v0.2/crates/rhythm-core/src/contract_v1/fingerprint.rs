//! R2-3a1: the fingerprint primitive — NFC pre-pass, JCS serialization,
//! SHA-256 — composed into `compute_plan_fingerprint_v1`.
//!
//! Scope note (R2-3 task card §4.1): a1 delivers the byte-exact primitive
//! over an already-validated payload value. The payload closed-key/semantic
//! validation is a later slice (a3); the gate entry point that forces it is
//! `plan_fingerprint_v1_gate` and is equally out of a1 scope.
//!
//! No FFI, no subprocesses: NFC (unicode-normalization), JCS (this crate)
//! and SHA-256 (sha2) are all independent Rust implementations.

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::contract_v1::canonical::{nfc_normalize_value, serialize_jcs};
use crate::contract_v1::error::ContractError;

pub const FINGERPRINT_PREFIX: &str = "plan-v1:sha256:";

/// Byte-exact fingerprint of a payload value: NFC over the whole tree
/// (strings AND object keys), then JCS serialization, then SHA-256 over the
/// canonical UTF-8 bytes. Output = `plan-v1:sha256:<64 lowercase hex>`.
pub fn compute_plan_fingerprint_v1(payload: &mut Value) -> Result<String, ContractError> {
    nfc_normalize_value(payload);
    let canonical = serialize_jcs(payload)?;
    Ok(format!(
        "{}{}",
        FINGERPRINT_PREFIX,
        sha256_hex(canonical.as_bytes())
    ))
}

/// JCS canonical bytes of an (NFC-normalized) value — exposed for the vector
/// tests that assert `expectedCanonical` byte-for-byte, and later for the
/// gate's payload check.
pub fn canonical_bytes(payload: &mut Value) -> Result<String, ContractError> {
    nfc_normalize_value(payload);
    serialize_jcs(payload)
}

pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}
