//! Alignment V2 domain model — versioned alignment result with explicit
//! ambiguity and diagnostics (PRD §3, Task B).
//!
//! The frozen `scoring_v1` types (`AlignmentPair` / `AlignmentResult`) stay
//! untouched; this module adapts their fields to the PRD's V2 model. Time
//! values keep the repository's `f64` millisecond domain — the PRD allows the
//! model to adapt to existing structures ("字段最终以仓库现有结构适配"); the
//! microsecond projection remains a contract-layer concern.
//!
//! Nothing here rewrites raw onset errors: `onset_error_ms` is always
//! `performed.onset_ms - score.target_onset_ms` (PRD invariant 3), regardless
//! of which alignment path produced the pair.

use crate::contract_v1::fingerprint::sha256_hex;
use crate::{CoreError, PerformedNoteV1, ScoreEvent};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Whether a confirmed pair carries the target's pitch. A wrong-pitch pair is
/// a real identification (misplaced note), never decomposed into
/// miss+extra to dodge the mistake (PRD §1.4 acceptance 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlignmentKind {
    CorrectPitch,
    WrongPitch,
}

impl AlignmentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AlignmentKind::CorrectPitch => "CORRECT_PITCH",
            AlignmentKind::WrongPitch => "WRONG_PITCH",
        }
    }
}

/// One confirmed score ↔ performed association. `match_cost` is an internal
/// diagnostic (lower = more confident), NOT a calibrated probability.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentPairV2 {
    pub score_event_id: String,
    pub performed_note_id: String,
    pub kind: AlignmentKind,
    /// `performed.onset_ms - score.target_onset_ms`; never adjusted by the
    /// alignment path.
    pub onset_error_ms: f64,
    /// Assignment cost from the aligner's own cost model; diagnostics only.
    pub match_cost: f64,
    /// True when the in-block assignment was not observable from pitch+time
    /// alone (e.g. cross-hand same-pitch unison). The deterministic
    /// assignment is still reported so scoring stays possible.
    pub assignment_ambiguous: bool,
    pub measure: u32,
}

/// A group whose internal assignment cannot be resolved from the observable
/// evidence. Reported instead of a false-certain answer (PRD §3.2 invariant 6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbiguousGroupV2 {
    pub score_event_ids: Vec<String>,
    pub performed_note_ids: Vec<String>,
    /// Stable machine code, e.g. `CROSS_HAND_SAME_PITCH_UNISON`.
    pub reason_code: String,
}

/// Stable-code diagnostic emitted by the aligner for evidence review.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentDiagnosticV2 {
    pub code: String,
    pub score_event_ids: Vec<String>,
    pub performed_note_ids: Vec<String>,
    pub detail: String,
}

/// Terminal status of one alignment run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AlignmentStatusV2 {
    Completed,
    /// The DP exceeded a configured resource budget; no result was produced
    /// and the caller must fall back (PRD §4.2 `ALIGNMENT_RESOURCE_LIMIT`).
    ResourceLimit {
        /// Stable machine code, currently `ALIGNMENT_RESOURCE_LIMIT`.
        reason_code: String,
    },
}

/// Versioned alignment output (PRD §3.2 `AlignmentResultV2`, adapted).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentResultV2 {
    pub pairs: Vec<AlignmentPairV2>,
    pub missed_score_event_ids: Vec<String>,
    pub extra_performed_ids: Vec<String>,
    /// Filled by the evidence-quality layer, not by the aligner; always empty
    /// in this crate for now (PRD keeps it in the model for the V2 pipeline).
    pub unassessable_score_event_ids: Vec<String>,
    pub ambiguous_groups: Vec<AmbiguousGroupV2>,
    pub diagnostics: Vec<AlignmentDiagnosticV2>,
    pub status: AlignmentStatusV2,
    pub algorithm_version: String,
    pub parameter_fingerprint: String,
}

impl Default for AlignmentResultV2 {
    fn default() -> Self {
        Self {
            pairs: Vec::new(),
            missed_score_event_ids: Vec::new(),
            extra_performed_ids: Vec::new(),
            unassessable_score_event_ids: Vec::new(),
            ambiguous_groups: Vec::new(),
            diagnostics: Vec::new(),
            status: AlignmentStatusV2::Completed,
            algorithm_version: String::new(),
            parameter_fingerprint: String::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Configuration

/// Explicit, versioned cost/budget parameters for the weighted sequence DP
/// candidate (PRD §4.2: no magic numbers scattered in business code). The
/// fingerprint below pins every reported result to the exact parameters used.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AlignmentDpConfigV1 {
    /// Soft time scale in ms: `|delta| / time_tau_ms` contributes linearly and
    /// never hard-rejects a pairing (PRD §4.2: time must not be a global hard
    /// gate; 300–400 ms late notes keep their pairing path).
    pub time_tau_ms: f64,
    /// Upper bound of the soft-time cost contribution per pair.
    pub time_cost_cap: f64,
    /// Finite cost of pairing a pitch-mismatched note — keeps real wrong notes
    /// identified as wrong-pitch pairs instead of miss+extra.
    pub pitch_mismatch_cost: f64,
    /// Cost of leaving a score target unpaired (missed).
    pub miss_cost: f64,
    /// Cost of leaving a performed note unpaired (extra).
    pub extra_cost: f64,
    /// Banded window between block onsets: pair transitions whose block
    /// onsets differ by more than this are not explored (bounds the DP to
    /// O(G × W) cells).
    pub band_ms: f64,
    /// Maximum DP cells; exceeding it aborts with `ResourceLimit`.
    pub max_cells: u64,
    /// Onset-group epsilon, matching `scoring_v1`'s chord grouping.
    pub same_onset_epsilon_ms: f64,
    /// When at least this many same-pitch notes exist on BOTH sides of one
    /// onset block, the in-block assignment is reported as ambiguous.
    pub ambiguous_same_pitch_min: usize,
}

impl Default for AlignmentDpConfigV1 {
    fn default() -> Self {
        Self {
            time_tau_ms: 250.0,
            time_cost_cap: 16.0,
            pitch_mismatch_cost: 40.0,
            miss_cost: 50.0,
            extra_cost: 30.0,
            band_ms: 8000.0,
            max_cells: 4_000_000,
            same_onset_epsilon_ms: 0.001,
            ambiguous_same_pitch_min: 2,
        }
    }
}

impl AlignmentDpConfigV1 {
    /// SHA-256 over the canonical serde JSON of the config (field order is
    /// declaration order, so the hex string is stable across runs).
    pub fn parameter_fingerprint(&self) -> String {
        let canonical = serde_json::to_string(self).unwrap_or_else(|_| String::from("unserializable"));
        sha256_hex(canonical.as_bytes())
    }

    /// Rejects non-finite or non-positive parameters before any DP runs.
    pub fn validate(&self) -> Result<(), CoreError> {
        let positive = [
            ("time_tau_ms", self.time_tau_ms),
            ("time_cost_cap", self.time_cost_cap),
            ("pitch_mismatch_cost", self.pitch_mismatch_cost),
            ("miss_cost", self.miss_cost),
            ("extra_cost", self.extra_cost),
            ("band_ms", self.band_ms),
        ];
        for (name, value) in positive {
            if !value.is_finite() || value <= 0.0 {
                return Err(CoreError::InvalidConfig(format!(
                    "alignment_dp_v1.{name} must be finite and > 0 (got {value})"
                )));
            }
        }
        if self.max_cells == 0 {
            return Err(CoreError::InvalidConfig("alignment_dp_v1.max_cells must be > 0".into()));
        }
        if !self.same_onset_epsilon_ms.is_finite() || self.same_onset_epsilon_ms < 0.0 {
            return Err(CoreError::InvalidConfig(
                "alignment_dp_v1.same_onset_epsilon_ms must be finite and >= 0".into(),
            ));
        }
        if self.ambiguous_same_pitch_min == 0 {
            return Err(CoreError::InvalidConfig(
                "alignment_dp_v1.ambiguous_same_pitch_min must be > 0".into(),
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Validation of results against their inputs

/// Structural invariants every V2 result must hold against its inputs
/// (PRD §3.2 modeling invariants): 1:1 pairing, mutual exclusion of
/// pairs/missed/extra, referential integrity, and raw onset errors that match
/// the input times exactly (the aligner may never wash a delta to zero).
pub fn validate_alignment_result_v2(
    result: &AlignmentResultV2,
    score_events: &[ScoreEvent],
    performed: &[PerformedNoteV1],
) -> Result<(), CoreError> {
    let score_by_id: HashMap<&str, &ScoreEvent> = score_events
        .iter()
        .map(|event| (event.score_event_id.as_str(), event))
        .collect();
    let performed_by_id: HashMap<&str, &PerformedNoteV1> = performed
        .iter()
        .map(|note| (note.performed_note_id.as_str(), note))
        .collect();

    let mut used_score: HashSet<&str> = HashSet::new();
    let mut used_performed: HashSet<&str> = HashSet::new();
    for pair in &result.pairs {
        let score_event = score_by_id.get(pair.score_event_id.as_str()).ok_or_else(|| {
            CoreError::InvalidEvent(format!("pair references unknown scoreEventId {}", pair.score_event_id))
        })?;
        let note = performed_by_id.get(pair.performed_note_id.as_str()).ok_or_else(|| {
            CoreError::InvalidEvent(format!("pair references unknown performedNoteId {}", pair.performed_note_id))
        })?;
        if !used_score.insert(pair.score_event_id.as_str()) {
            return Err(CoreError::InvalidEvent(format!(
                "scoreEventId {} appears in more than one pair",
                pair.score_event_id
            )));
        }
        if !used_performed.insert(pair.performed_note_id.as_str()) {
            return Err(CoreError::InvalidEvent(format!(
                "performedNoteId {} appears in more than one pair",
                pair.performed_note_id
            )));
        }
        let expected_error = note.onset_ms - score_event.target_onset_ms;
        if (pair.onset_error_ms - expected_error).abs() > 1e-9 {
            return Err(CoreError::InvalidEvent(format!(
                "pair onset_error_ms {} does not match raw times {}",
                pair.onset_error_ms, expected_error
            )));
        }
        let expected_kind = if note.pitch == score_event.pitch {
            AlignmentKind::CorrectPitch
        } else {
            AlignmentKind::WrongPitch
        };
        if pair.kind != expected_kind {
            return Err(CoreError::InvalidEvent(format!(
                "pair kind {} disagrees with input pitches",
                pair.kind.as_str()
            )));
        }
    }

    for score_event_id in &result.missed_score_event_ids {
        let id = score_event_id.as_str();
        if !score_by_id.contains_key(id) {
            return Err(CoreError::InvalidEvent(format!("missed id {id} is not a score event")));
        }
        if used_score.contains(id) {
            return Err(CoreError::InvalidEvent(format!("scoreEventId {id} is both paired and missed")));
        }
    }
    for performed_note_id in &result.extra_performed_ids {
        let id = performed_note_id.as_str();
        if !performed_by_id.contains_key(id) {
            return Err(CoreError::InvalidEvent(format!("extra id {id} is not a performed note")));
        }
        if used_performed.contains(id) {
            return Err(CoreError::InvalidEvent(format!("performedNoteId {id} is both paired and extra")));
        }
    }

    for group in &result.ambiguous_groups {
        for score_event_id in &group.score_event_ids {
            if !score_by_id.contains_key(score_event_id.as_str()) {
                return Err(CoreError::InvalidEvent(format!(
                    "ambiguous group references unknown scoreEventId {score_event_id}"
                )));
            }
        }
        for performed_note_id in &group.performed_note_ids {
            if !performed_by_id.contains_key(performed_note_id.as_str()) {
                return Err(CoreError::InvalidEvent(format!(
                    "ambiguous group references unknown performedNoteId {performed_note_id}"
                )));
            }
        }
    }

    for diagnostic in &result.diagnostics {
        if diagnostic.code.is_empty() {
            return Err(CoreError::InvalidEvent("diagnostic code must be non-empty".into()));
        }
    }
    Ok(())
}
