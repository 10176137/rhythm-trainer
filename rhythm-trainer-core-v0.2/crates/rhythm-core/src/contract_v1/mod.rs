//! R2-3 contract_v1 module. Stage a1 (this slice): NFC/JCS/SHA-256
//! fingerprint primitives, byte-exact against the six committed vectors.
//! Later slices: rational/integer-µs time (a2), document projection and
//! validation + the mandatory fingerprint gate (a3), planner semantics.

pub mod canonical;
pub mod error;
pub mod fingerprint;
pub mod payload;

pub use canonical::{nfc_normalize_value, serialize_jcs};
pub use error::ContractError;
pub use fingerprint::{canonical_bytes, compute_plan_fingerprint_v1, sha256_hex};
pub use payload::PlanFingerprintPayloadV1;
