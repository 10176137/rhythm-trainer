//! R2-3a1: RFC 8785 (JCS) serialization restricted to the frozen
//! PlanFingerprintPayloadV1 value domain, plus the NFC pre-pass.
//!
//! Contract scope (TS_RUST_PARITY_GATE_V1 §3.5, R2-3 task card §2/§3):
//! payload numbers are JSON integers within the safe-integer domain; there
//! are no fractional floats, so the ECMAScript number-serialization rules of
//! JCS reduce to plain decimal integers. A non-integer number is a contract
//! violation and is rejected here rather than approximated.
//!
//! Key ordering: RFC 8785 sorts object keys by their UTF-16 code-unit
//! sequence (ECMAScript compatibility) — NOT by UTF-8 byte order. The two
//! orders differ for characters outside the BMP (e.g. U+10000 sorts before
//! U+FFFD in UTF-16 but after it in UTF-8 bytes), which the committed
//! negative test pins down.

use serde_json::{Map, Number, Value};
use unicode_normalization::UnicodeNormalization;

use crate::contract_v1::error::ContractError;

/// Deep NFC normalization of every string in the value tree — keys included.
/// Mirrors the TS reference: NFC runs as a pre-pass over the whole payload
/// before JCS (plan-fingerprint.ts, NFC-by-deep-walk).
pub fn nfc_normalize_value(value: &mut Value) {
    match value {
        Value::String(s) => *s = s.nfc().collect::<String>(),
        Value::Array(items) => {
            for item in items {
                nfc_normalize_value(item);
            }
        }
        Value::Object(map) => {
            let rebuilt: Map<String, Value> = map
                .iter_mut()
                .map(|(key, item)| {
                    let normalized = key.nfc().collect::<String>();
                    nfc_normalize_value(item);
                    (normalized, std::mem::take(item))
                })
                .collect();
            *map = rebuilt;
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// JCS serialization over the restricted payload value domain.
pub fn serialize_jcs(value: &Value) -> Result<String, ContractError> {
    let mut out = String::new();
    write_jcs(value, &mut out)?;
    Ok(out)
}

fn write_jcs(value: &Value, out: &mut String) -> Result<(), ContractError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&serialize_number(number)?),
        Value::String(text) => write_json_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_jcs(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // RFC 8785 §3.2.3: sort keys by UTF-16 code-unit sequence.
            let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
            keys.sort_by(|a, b| utf16_code_unit_cmp(a, b));
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json_string(key, out);
                out.push(':');
                write_jcs(&map[*key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn serialize_number(number: &Number) -> Result<String, ContractError> {
    // Frozen payload domain: integers only (rationals are "n/d" strings;
    // ticks, counts and enums are integers). Fractional floats never appear
    // in a validated payload, and ECMAScript float serialization is exactly
    // where hand-rolled JCS implementations go wrong — so reject, don't
    // approximate.
    if let Some(int) = number.as_i64() {
        return Ok(int.to_string());
    }
    if let Some(uint) = number.as_u64() {
        return Ok(uint.to_string());
    }
    Err(ContractError::new(
        "NON_INTEGER_NUMBER",
        "JCS domain violation: payload numbers must be integers",
    ))
}

fn write_json_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0A}' => out.push_str("\\n"),
            '\u{0C}' => out.push_str("\\f"),
            '\u{0D}' => out.push_str("\\r"),
            // ECMAScript JSON.stringify escapes only C0 controls below 0x20
            // (with the short forms above); DEL (0x7F) and all other code
            // points are emitted literally as UTF-8.
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// RFC 8785 key order: lexicographic over UTF-16 code units.
fn utf16_code_unit_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}
