//! R2-3a1 acceptance: the six committed fingerprint vectors must reproduce
//! byte-exact under the independent Rust implementation (NFC + JCS + SHA-256,
//! no FFI to the TS reference).
//!
//! Truth source: audit-r1/contracts/test-vectors/plan-fingerprint-v1.json
//! (5 frozen from R2-0 + V-rational-bpm from R2-2). The vectors are read,
//! never modified; any mismatch is an implementation defect.

use rhythm_core::contract_v1::{canonical_bytes, compute_plan_fingerprint_v1};
use serde_json::Value;

const VECTORS_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../audit-r1/contracts/test-vectors/plan-fingerprint-v1.json"
);

fn load_vectors() -> serde_json::Map<String, Value> {
    let raw = std::fs::read_to_string(VECTORS_PATH)
        .unwrap_or_else(|error| panic!("read committed vectors: {error}"));
    let parsed: Value = serde_json::from_str(&raw).expect("vectors JSON parses");
    parsed["vectors"].as_object().expect("vectors object").clone()
}

#[test]
fn six_committed_vectors_are_byte_exact() {
    let vectors = load_vectors();
    let names: Vec<&String> = vectors.keys().collect();
    // The five R2-0 frozen names must all be present plus V-rational-bpm.
    for required in [
        "V-single",
        "V-rest-gap",
        "V-chord",
        "V-tie",
        "V-hand",
        "V-rational-bpm",
    ] {
        assert!(names.contains(&&required.to_string()), "missing vector {required}");
    }

    for (name, vector) in &vectors {
        let expected_fingerprint = vector["expectedFingerprint"].as_str().unwrap_or_else(|| {
            panic!("{name}: missing expectedFingerprint")
        });
        let expected_canonical = vector["expectedCanonical"].as_str().unwrap_or_else(|| {
            panic!("{name}: missing expectedCanonical")
        });

        let mut payload = vector["payload"].clone();

        // Path 1: fingerprint primitive (NFC -> JCS -> SHA-256).
        let fingerprint = compute_plan_fingerprint_v1(&mut payload)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(
            fingerprint, expected_fingerprint,
            "{name}: fingerprint mismatch"
        );

        // Path 2: canonical bytes must equal the committed serialization
        // byte-for-byte (and round-trip through the fingerprint hash).
        let canonical = canonical_bytes(&mut payload)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(canonical, expected_canonical, "{name}: canonical bytes");

        use sha2::{Digest, Sha256};
        let from_bytes = format!(
            "plan-v1:sha256:{}",
            Sha256::digest(canonical.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        assert_eq!(from_bytes, expected_fingerprint, "{name}: sha256(canonical)");
    }
}

/// RFC 8785 key order is UTF-16 code-unit sequence, which differs from UTF-8
/// byte order outside the BMP: U+FFFD encodes as EF BF BD while U+10000
/// encodes as F0 90 80 80, yet in UTF-16 U+FFFD (0xFFFD) sorts AFTER the
/// high surrogate pair starting 0xD800. A byte-order sort would emit the
/// wrong key order — this negative test pins the RFC behavior.
#[test]
fn jcs_orders_keys_by_utf16_code_units_not_utf8_bytes() {
    use rhythm_core::contract_v1::serialize_jcs;
    use serde_json::json;

    // U+FFFD (replacement char) vs U+10000 (non-BMP): UTF-16 order puts
    // U+10000 (surrogate pair 0xD800_0xDC00) BEFORE U+FFFD (0xFFFD), while
    // UTF-8 byte order would put U+FFFD (EF BF BD) first. JCS must use the
    // UTF-16 order.
    let value = json!({ "\u{FFFD}": 1, "\u{10000}": 2 });
    let canonical = serialize_jcs(&value).expect("serialize");
    let expected = format!(
        "{{\"{}\":2,\"{}\":1}}",
        '\u{10000}',
        '\u{FFFD}'
    );
    assert_eq!(canonical, expected);
}

/// ECMAScript JSON.stringify escapes only the five short-form controls plus
/// other C0 controls as \u00xx; DEL (0x7F) and non-ASCII stay literal. The
/// expected string below was produced by Node's JSON.stringify on the exact
/// same input (authoritative for RFC 8785 §3.2.2.2).
#[test]
fn jcs_string_escaping_matches_ecmascript() {
    use rhythm_core::contract_v1::serialize_jcs;
    use serde_json::Value;

    let text = "back\u{0008}space\ttab\nnl\u{000C}fg\rd\u{0001}c1 \u{007F}del \"q\" \\ emoji\u{1D11E}";
    let value = Value::Array(vec![Value::String(String::from(text))]);
    let canonical = serialize_jcs(&value).expect("serialize");
    let expected = concat!(
        "[\"back\\bspace\\ttab\\nnl\\ffg\\rd\\u0001c1 ",
        "\u{007F}del \\\"q\\\" \\\\ emoji\u{1D11E}\"]"
    );
    assert_eq!(canonical, expected);
}

/// The payload domain carries integers only; a fractional float is a domain
/// violation and must be rejected instead of serialized through any float
/// formatting path.
#[test]
fn jcs_rejects_non_integer_numbers() {
    use rhythm_core::contract_v1::serialize_jcs;
    use serde_json::json;

    let value = json!({ "bpm": 175.5 });
    let error = serialize_jcs(&value).expect_err("fractional float must be rejected");
    assert_eq!(error.code, "NON_INTEGER_NUMBER");
}
