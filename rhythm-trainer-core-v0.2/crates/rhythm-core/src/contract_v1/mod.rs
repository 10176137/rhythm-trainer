//! R2-3 contract_v1 module. Stage a1 (this slice): NFC/JCS/SHA-256
//! fingerprint primitives, byte-exact against the six committed vectors.
//! Later slices: rational/integer-µs time (a2), document projection and
//! validation + the mandatory fingerprint gate (a3), planner semantics.

pub mod canonical;
pub mod config;
pub mod document;
pub mod error;
pub mod fingerprint;
pub mod gate;
pub mod payload;
pub mod payload_check;
pub use payload_check::validate_plan_fingerprint_payload_v1;
pub mod planner;
pub mod project;
pub mod rational;
pub mod time;

pub use canonical::{nfc_normalize_value, serialize_jcs};
pub use config::{parse_plan_request_config, PlanRequestConfig};
pub use document::{Issue, validate_score_document_v1};
pub use error::ContractError;
pub use fingerprint::{canonical_bytes, compute_plan_fingerprint_v1, sha256_hex};
pub use gate::{build_payload, plan_fingerprint_v1_gate};
pub use payload::PlanFingerprintPayloadV1;
pub use planner::{build_parity_candidate_v1, build_plan_v1};
pub use project::project_score_document_v1;
pub use rational::RationalV1;
pub use time::{beat_to_microseconds, count_in_beats, target_onset_us};
