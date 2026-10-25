//! R2-3d E4-C: the Rust-side candidate-output target validator emitting the
//! four frozen normative codes of the Gate §6 mapping table. TS keeps its
//! message-anchor transition (engine-server plain errors + harness mapping);
//! per the frozen code-table boundary the Rust side produces the normative
//! codes directly from day one — same layer as the server/candidate-output
//! validation, NOT a production server change (pure function, offline
//! acceptance surface).
//!
//! Judgement criteria mirror `normative-codes.ts validateCandidateScoreEvents`
//! exactly (field order, integer semantics, set comparison).

use serde_json::Value;

pub const DUPLICATE_TARGET_ID: &str = "duplicate_target_id";
pub const INVALID_TARGET_PITCH: &str = "invalid_target_pitch";
pub const MEASURE_COVERAGE_MISMATCH: &str = "measure_coverage_mismatch";
pub const TARGET_OUTSIDE_PRESCRIPTION_RANGE: &str = "target_outside_prescription_range";

#[derive(Debug, Clone, Default)]
pub struct CandidateValidationOptions {
    /// Bars spanned by note atoms; when present, measure coverage is enforced.
    pub atom_bars: Option<Vec<f64>>,
    /// Prescription measure range; when present, out-of-range targets are rejected.
    pub prescription_range: Option<(f64, f64)>,
}

fn is_finite_number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite())
}

fn is_integer_number(value: &Value) -> Option<f64> {
    is_finite_number(value).filter(|v| v.fract() == 0.0)
}

/// Returns the first frozen normative code violated by the candidate score
/// events, or `None` when the candidate is acceptable. Never returns
/// empty-plan/warning outcomes: rejection is the only failure mode
/// (fail-closed per the parity gate §6/C).
pub fn validate_candidate_score_events(
    events: &Value,
    options: &CandidateValidationOptions,
) -> Option<&'static str> {
    let list = events.as_array()?;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for event in list {
        let score_event_id = event.get("scoreEventId").and_then(Value::as_str).unwrap_or_default();
        let pitch = event.get("pitch").map(is_integer_number).unwrap_or(None);
        let measure = event.get("measure").map(is_integer_number).unwrap_or(None);
        let duration = event.get("targetDurationMs").map(is_finite_number).unwrap_or(None);
        let pitch_ok = matches!(pitch, Some(p) if (0.0..=127.0).contains(&p));
        let measure_ok = matches!(measure, Some(m) if m >= 1.0);
        if score_event_id.is_empty() || duration.is_none() || !pitch_ok || !measure_ok {
            return Some(INVALID_TARGET_PITCH);
        }
        if !matches!(duration, Some(d) if d > 0.0) {
            return Some(INVALID_TARGET_PITCH);
        }
        if !seen.insert(score_event_id.to_string()) {
            return Some(DUPLICATE_TARGET_ID);
        }
    }
    if let Some((start, end)) = options.prescription_range {
        let outside = list.iter().any(|event| {
            let measure = event.get("measure").and_then(Value::as_f64);
            matches!(measure, Some(m) if m < start || m > end)
        });
        if outside {
            return Some(TARGET_OUTSIDE_PRESCRIPTION_RANGE);
        }
    }
    if let Some(atom_bars) = &options.atom_bars {
        let measure_set: std::collections::BTreeSet<i64> = list
            .iter()
            .filter_map(|event| event.get("measure").and_then(Value::as_i64))
            .collect();
        let bar_set: std::collections::BTreeSet<i64> =
            atom_bars.iter().filter_map(|bar| finite_to_i64(*bar)).collect();
        if measure_set.len() != bar_set.len()
            || bar_set.iter().any(|bar| !measure_set.contains(bar))
        {
            return Some(MEASURE_COVERAGE_MISMATCH);
        }
    }
    None
}

fn finite_to_i64(value: f64) -> Option<i64> {
    if value.is_finite() && value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        Some(value as i64)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mirrors_the_ts_validator_decision_for_decision() {
        let clean = json!([
            { "scoreEventId": "a", "pitch": 60, "measure": 1, "targetDurationMs": 750.0 }
        ]);
        assert_eq!(validate_candidate_score_events(&clean, &Default::default()), None);

        // N-PITCH-C1: non-integer / out-of-range pitch, non-positive duration.
        let bad_pitch = json!([
            { "scoreEventId": "a", "pitch": 128, "measure": 1, "targetDurationMs": 750.0 }
        ]);
        assert_eq!(validate_candidate_score_events(&bad_pitch, &Default::default()), Some(INVALID_TARGET_PITCH));
        let zero_duration = json!([
            { "scoreEventId": "a", "pitch": 60, "measure": 1, "targetDurationMs": 0.0 }
        ]);
        assert_eq!(validate_candidate_score_events(&zero_duration, &Default::default()), Some(INVALID_TARGET_PITCH));

        // N-ID-C1: duplicate wire target id in one scoring array.
        let duplicated = json!([
            { "scoreEventId": "a", "pitch": 60, "measure": 1, "targetDurationMs": 750.0 },
            { "scoreEventId": "a", "pitch": 62, "measure": 2, "targetDurationMs": 750.0 }
        ]);
        assert_eq!(validate_candidate_score_events(&duplicated, &Default::default()), Some(DUPLICATE_TARGET_ID));

        // N-COV-C2: prescription range.
        let outside = json!([
            { "scoreEventId": "a", "pitch": 60, "measure": 9, "targetDurationMs": 750.0 }
        ]);
        let options = CandidateValidationOptions { prescription_range: Some((1.0, 2.0)), ..Default::default() };
        assert_eq!(validate_candidate_score_events(&outside, &options), Some(TARGET_OUTSIDE_PRESCRIPTION_RANGE));

        // N-COV-C1: measure set must equal the atom bar set.
        let coverage = json!([
            { "scoreEventId": "a", "pitch": 60, "measure": 1, "targetDurationMs": 750.0 }
        ]);
        let options = CandidateValidationOptions { atom_bars: Some(vec![1.0, 2.0]), ..Default::default() };
        assert_eq!(validate_candidate_score_events(&coverage, &options), Some(MEASURE_COVERAGE_MISMATCH));

        // Range-loop legal repetition lives OUTSIDE one scoring array (§3.0):
        // the validator only sees one array, so cross-array repeats never hit it.
    }
}
