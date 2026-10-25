//! R2-3a3: projection-level fail-closed checks over the contract JSON
//! instances (ScoreDocumentV1 + ImportReportV1). Mirrors TS
//! `projectScoreDocumentV1` (:172) error-for-error, adapted to the frozen
//! data boundary: the document input is the ScoreDocumentV1 JSON instance
//! (source fingerprint at `source.sourceFingerprint`, `sha256:`-prefixed);
//! the report carries the bare 64-hex `fingerprint`.

use serde_json::Value;

use crate::contract_v1::document::{compute_score_revision_id, CAPABILITY_ENUM};
use crate::contract_v1::error::ContractError;

pub const NORMALIZER_VERSION: &str = "normalizer-1";
pub const SUPPORT_PROFILE_VERSION_V1: &str = "musicxml-v1.0";

fn err(code: &str, message: impl Into<String>) -> ContractError {
    ContractError::new(code, message)
}

/// Normalizes a `sha256:<64 lowercase hex>` value to the bare hex. Fails with
/// `INVALID_SOURCE_FINGERPRINT` on any other shape (C-12 five-step rule).
pub fn strip_sha256_prefix(value: &str) -> Result<String, ContractError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(err("INVALID_SOURCE_FINGERPRINT",
            format!("source fingerprint must be sha256:<64 hex>, got {value}")));
    };
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(err("INVALID_SOURCE_FINGERPRINT",
            format!("source fingerprint must be sha256:<64 lowercase hex>, got {value}")));
    }
    Ok(hex.to_string())
}

/// Projection: binding check + fail-closed invariants + deterministic
/// normalized DTO. The DTO is the input document value with the frozen
/// normalization applied (capabilities merged from the report and sorted).
pub fn project_score_document_v1(
    document: &Value,
    report: &Value,
) -> Result<Value, ContractError> {
    let report_fingerprint = report.get("fingerprint")
        .and_then(Value::as_str)
        .ok_or_else(|| err("INVALID_SOURCE_FINGERPRINT", "report.fingerprint missing"))?;
    if report_fingerprint.len() != 64
        || !report_fingerprint.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(err("INVALID_SOURCE_FINGERPRINT",
            format!("report.fingerprint is not bare sha256 hex: {report_fingerprint}")));
    }

    // C-12 five-step rule: source.sourceFingerprint (sha256:-prefixed) is the
    // ONLY fingerprint the V1 document carries.
    let source_fingerprint_prefixed = document
        .get("source")
        .and_then(|source| source.get("sourceFingerprint"))
        .and_then(Value::as_str)
        .ok_or_else(|| err("INVALID_SOURCE_FINGERPRINT", "source.sourceFingerprint missing"))?;
    let bare = strip_sha256_prefix(source_fingerprint_prefixed)?;
    if bare != report_fingerprint {
        return Err(err("DOCUMENT_REPORT_MISMATCH",
            format!("document fingerprint {source_fingerprint_prefixed} does not match report fingerprint {report_fingerprint}")));
    }

    // Closed capability enums on both the document and the report.
    let mut capabilities: Vec<String> = Vec::new();
    for (where_, value) in [("capability", document.get("capabilities")), ("report capability", report.get("capabilities"))] {
        if let Some(list) = value.and_then(Value::as_array) {
            for capability in list {
                let Some(name) = capability.as_str() else {
                    return Err(err("UNKNOWN_CAPABILITY",
                        format!("{where_} not in frozen enum: {capability}")));
                };
                if !CAPABILITY_ENUM.contains(&name) {
                    return Err(err("UNKNOWN_CAPABILITY",
                        format!("{where_} not in frozen enum: {name}")));
                }
                if !capabilities.iter().any(|existing| existing == name) {
                    capabilities.push(name.to_string());
                }
            }
        }
    }
    capabilities.sort();

    // Deterministic normalized DTO: the validated input with the merged,
    // sorted capabilities written back.
    let mut normalized = document.clone();
    if let Some(object) = normalized.as_object_mut() {
        object.insert("capabilities".to_string(),
            serde_json::Value::Array(capabilities.into_iter().map(Value::String).collect()));
    }
    Ok(normalized)
}

/// The projection's own scoreRevisionId (frozen formula) — used by the gate
/// to build the payload from the validated document.
pub fn projected_score_revision_id(document: &Value) -> Result<String, ContractError> {
    let source_fingerprint = document
        .get("source")
        .and_then(|source| source.get("sourceFingerprint"))
        .and_then(Value::as_str)
        .ok_or_else(|| err("INVALID_SOURCE_FINGERPRINT", "source.sourceFingerprint missing"))?;
    Ok(compute_score_revision_id(source_fingerprint, NORMALIZER_VERSION))
}
