//! R2-3d E3 + E4-A: Rust-side migration evidence.
//!
//! E3 — every committed fingerprint vector is recomputed by the independent
//! Rust implementation (NFC/JCS/SHA-256 all in-tree, no FFI) and compared
//! BYTE-EXACT against the frozen canonical bytes and expected hash.
//! E4-A — the frozen A-class sensitivity/invariance matrix executed on the
//! committed V-single payload: N-PITCH-S1/S2 and the nine single-field N-FP-S1
//! tampering items must each CHANGE the fingerprint; the semantic-preserving
//! runtime-ID re-encoding (N-FP-S2) must NOT.
//!
//! Both evidence blocks are written to
//! `audit-r1/reports/r2-3/r2-3d-rust-evidence.json` (regenerated on every
//! run; the E6 aggregation reads it).

use rhythm_core::contract_v1::{canonical_bytes, compute_plan_fingerprint_v1, validate_score_document_v1, build_plan_v1, plan_fingerprint_v1_gate};
use serde_json::{json, Value};

const VECTORS_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../audit-r1/contracts/test-vectors/plan-fingerprint-v1.json"
);
const CORPUS_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../audit-r1/fixtures/parity-cases/rust-parity-input"
);
const EVIDENCE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../audit-r1/reports/r2-3/r2-3d-rust-evidence.json"
);

fn load_vectors() -> serde_json::Map<String, Value> {
    let raw = std::fs::read_to_string(VECTORS_PATH).expect("read committed vectors");
    let parsed: Value = serde_json::from_str(&raw).expect("vectors JSON parses");
    parsed["vectors"].as_object().expect("vectors object").clone()
}

/// E3: byte-exact recomputation of ALL committed vectors, with per-vector
/// evidence (input name, computed canonical bytes, computed hash, frozen
/// expectations, comparison states).
#[test]
fn e3_committed_vectors_reproduce_byte_exact_with_evidence() {
    let vectors = load_vectors();
    let mut entries = Vec::new();
    let mut all_exact = true;
    for (name, vector) in &vectors {
        let expected_fingerprint = vector["expectedFingerprint"].as_str().expect("expectedFingerprint");
        let expected_canonical = vector["expectedCanonical"].as_str().expect("expectedCanonical");
        let mut payload = vector["payload"].clone();

        let computed_fingerprint = compute_plan_fingerprint_v1(&mut payload)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let computed_canonical = canonical_bytes(&mut payload)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let canonical_match = computed_canonical == *expected_canonical;
        let fingerprint_match = computed_fingerprint == *expected_fingerprint;
        all_exact &= canonical_match && fingerprint_match;
        entries.push(json!({
            "vector": name,
            "canonicalMatch": canonical_match,
            "fingerprintMatch": fingerprint_match,
            "computedFingerprint": computed_fingerprint,
            "expectedFingerprint": expected_fingerprint,
            "computedCanonical": computed_canonical,
            "expectedCanonicalRef": "audit-r1/contracts/test-vectors/plan-fingerprint-v1.json (frozen, not duplicated here)",
        }));
    }
    // Non-integer rational BPM coverage (Gate §7): V-rational-bpm must be in
    // the committed set — if absent, the coverage claim would be false.
    let rational_bpm_present = vectors.contains_key("V-rational-bpm");
    assert!(rational_bpm_present, "V-rational-bpm must exist for §7 coverage");
    assert!(all_exact, "E3: every vector must reproduce byte-exact");

    serde_json::to_writer_pretty(
        std::fs::File::create(EVIDENCE_PATH).expect("create evidence file"),
        &json!({ "vectors": entries, "allByteExact": all_exact, "rationalBpmVectorPresent": rational_bpm_present }),
    )
    .expect("write E3 evidence");
}

fn base_payload() -> Value {
    let vectors = load_vectors();
    vectors["V-single"]["payload"].clone()
}

/// E4-A: the frozen sensitivity/invariance matrix over the committed payload.
#[test]
fn e4a_fingerprint_sensitivity_and_invariance_matrix() {
    let base = base_payload();
    let baseline = compute_plan_fingerprint_v1(&mut base.clone()).expect("baseline fingerprint");

    // N-PITCH-S1: member midiNote changes => fingerprint changes.
    let mut s1 = base.clone();
    let old_midi = s1["targetGroups"][0]["members"][0]["pitch"]["midiNote"].as_i64().expect("midi");
    s1["targetGroups"][0]["members"][0]["pitch"]["midiNote"] = json!(old_midi + 1);
    // N-PITCH-S2: spelling changes with the SAME midiNote (enharmonic).
    let mut s2 = base.clone();
    s2["targetGroups"][0]["members"][0]["pitch"]["spelling"] = json!("B#3");
    assert_eq!(s2["targetGroups"][0]["members"][0]["pitch"]["midiNote"].as_i64(), Some(60));

    // N-FP-S1: nine single-field config tampering items (all stay LEGAL so
    // the gate still hashes them — a violation would be a rejection, not a
    // fingerprint change).
    let mut items: Vec<(String, Value)> = Vec::new();
    let mut tamper = |name: &str, mutate: &dyn Fn(&mut Value)| {
        let mut payload = base.clone();
        mutate(&mut payload);
        items.push((name.to_string(), payload));
    };
    tamper("N-FP-S1 scope.partId", &|p| {
        p["scope"]["partId"] = json!("P2");
    });
    tamper("N-FP-S1 scope.hand", &|p| {
        // Flip whatever the vector carries (right<->left, both->right) — a
        // hard-coded value could equal the original and prove nothing.
        let flipped = match p["scope"]["hand"].as_str() {
            Some("right") => "left",
            Some("left") => "right",
            _ => "right",
        };
        p["scope"]["hand"] = json!(flipped);
    });
    tamper("N-FP-S1 repeatSelection", &|p| {
        p["repeatSelection"] = json!({ "kind": "range-loop", "count": 2 });
    });
    tamper("N-FP-S1 bpm", &|p| {
        p["tempo"]["bpm"] = json!({ "numerator": 81, "denominator": 1 });
    });
    tamper("N-FP-S1 ticksPerQuarter", &|p| {
        p["tempo"]["ticksPerQuarter"] = json!(480);
    });
    tamper("N-FP-S1 countInBeats", &|p| {
        p["tempo"]["countInBeats"] = json!({ "numerator": 5, "denominator": 1 });
    });
    tamper("N-FP-S1 plannerVersion", &|p| {
        p["plannerVersion"] = json!("parity-harness-1*");
    });
    tamper("N-FP-S1 scoreRevisionId", &|p| {
        p["scoreRevisionId"] = json!(format!("score-revision-v1:sha256:{}", "f".repeat(64)));
    });
    tamper("N-FP-S1 normalizerVersion", &|p| {
        p["normalizerVersion"] = json!("normalizer-1*");
    });

    let mut class_a = vec![
        json!({
            "id": "N-PITCH-S1",
            "operation": "member midiNote +1",
            "expected": "changed",
            "fingerprintChanged": compute_plan_fingerprint_v1(&mut s1).expect("S1") != baseline,
        }),
        json!({
            "id": "N-PITCH-S2",
            "operation": "spelling C4->B#3 with identical midiNote",
            "expected": "changed",
            "fingerprintChanged": compute_plan_fingerprint_v1(&mut s2).expect("S2") != baseline,
        }),
    ];
    for (name, mut payload) in items {
        let changed = compute_plan_fingerprint_v1(&mut payload).expect("N-FP-S1 item") != baseline;
        class_a.push(json!({ "id": name, "operation": "single-field tamper", "expected": "changed", "fingerprintChanged": changed }));
    }

    // N-FP-S2: consistent internal-ID re-encoding with unchanged semantics
    // must NOT change the fingerprint (full-chain: document -> plan -> gate).
    let record: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{CORPUS_DIR}/G1-base.json")).expect("read corpus"),
    )
    .expect("corpus parses");
    let mut renamed_document = record["document"].clone();
    for part in renamed_document["parts"].as_array_mut().expect("parts") {
        for measure in part["measures"].as_array_mut().expect("measures") {
            for event in measure["events"].as_array_mut().expect("events") {
                let renamed = format!("renamed:{}", event["eventId"].as_str().expect("eventId"));
                event["eventId"] = json!(renamed);
            }
        }
    }
    assert!(validate_score_document_v1(&renamed_document).is_empty(), "renamed document stays valid");
    let renamed_plan = build_plan_v1(&renamed_document, &record["report"], &record["config"]).expect("plan");
    let renamed_fingerprint = plan_fingerprint_v1_gate(
        &renamed_document, &record["report"], &renamed_plan, &record["config"],
    ).expect("gate on renamed plan");
    let original_plan = build_plan_v1(&record["document"], &record["report"], &record["config"]).expect("plan");
    let original_fingerprint = plan_fingerprint_v1_gate(
        &record["document"], &record["report"], &original_plan, &record["config"],
    ).expect("gate on original plan");
    let s2_invariant = renamed_fingerprint == original_fingerprint;
    class_a.push(json!({
        "id": "N-FP-S2",
        "operation": "consistent internal event-ID re-encoding, semantics unchanged (full chain)",
        "expected": "invariant",
        "fingerprintChanged": !s2_invariant,
    }));

    for entry in &class_a {
        let expected_changed = entry["expected"] == "changed";
        assert_eq!(
            entry["fingerprintChanged"], expected_changed,
            "{}: fingerprint must {}",
            entry["id"],
            if expected_changed { "change" } else { "stay invariant" }
        );
    }

    // Merge into the shared evidence file (E3 writes it too; the file is
    // regenerated atomically on every full test run).
    let mut evidence = std::fs::read_to_string(EVIDENCE_PATH)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));
    evidence["schemaVersion"] = json!("r2-3d-rust-evidence-v1");
    evidence["classA"] = json!(class_a);
    serde_json::to_writer_pretty(
        std::fs::File::create(EVIDENCE_PATH).expect("rewrite evidence"),
        &evidence,
    )
    .expect("write E4-A evidence");
}
