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
use crate::{AlignmentPair, AlignmentResult, CoreError, PerformedNoteV1, ScoreEvent, ScoringConfig};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

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
    /// Onset-group epsilon for SCORE blocks, matching `scoring_v1`'s chord
    /// grouping (score chord tones share the exact notated onset).
    pub same_onset_epsilon_ms: f64,
    /// Performed blocks merge notes arriving within this spread so a rolled /
    /// arpeggiated chord (arrivals tens of ms apart) pairs its score block as
    /// ONE block instead of shattering into per-note blocks. Must stay well
    /// below the fastest intended sequential note spacing.
    pub performed_spread_epsilon_ms: f64,
    /// When at least this many same-pitch notes exist on BOTH sides of one
    /// onset block, the in-block assignment is reported as ambiguous.
    pub ambiguous_same_pitch_min: usize,
    /// Largest onset block the in-block subset assignment will attempt;
    /// larger blocks abort with `ResourceLimit` instead of exploding 2^k
    /// masks. Hard ceiling is 16 so a single block can never exhaust memory.
    pub max_block_notes: usize,
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
            performed_spread_epsilon_ms: 80.0,
            ambiguous_same_pitch_min: 2,
            max_block_notes: 12,
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
        if !self.performed_spread_epsilon_ms.is_finite() || self.performed_spread_epsilon_ms <= 0.0 {
            return Err(CoreError::InvalidConfig(
                "alignment_dp_v1.performed_spread_epsilon_ms must be finite and > 0".into(),
            ));
        }
        if self.ambiguous_same_pitch_min == 0 {
            return Err(CoreError::InvalidConfig(
                "alignment_dp_v1.ambiguous_same_pitch_min must be > 0".into(),
            ));
        }
        if self.max_block_notes == 0 || self.max_block_notes > 16 {
            return Err(CoreError::InvalidConfig(
                "alignment_dp_v1.max_block_notes must be within 1..=16".into(),
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

// ---------------------------------------------------------------------------
// Weighted sequence DP candidate (PRD §4.2, Task C)

/// Algorithm identity stamped on every DP V2 result.
pub const ALIGNMENT_DP_V2_ALGORITHM_VERSION: &str = "alignment-dp-v2";
/// Stable reason code when a configured resource budget is exceeded (PRD §4.2);
/// the caller must fall back instead of forcing a low-quality result.
pub const ALIGNMENT_RESOURCE_LIMIT: &str = "ALIGNMENT_RESOURCE_LIMIT";
/// Stable reason code for same-pitch in-block assignment ambiguity: when both
/// sides of one onset block carry several notes of the same pitch, MIDI pitch
/// + time cannot observe WHICH instance was played.
pub const SAME_PITCH_ASSIGNMENT_AMBIGUOUS: &str = "SAME_PITCH_ASSIGNMENT_AMBIGUOUS";
/// Diagnostic code for pairs recovered beyond the legacy ±`max_onset_deviation_ms`
/// window — raw errors stay preserved for grading.
pub const LATE_BUT_PAIRED_BEYOND_LEGACY_WINDOW: &str = "LATE_BUT_PAIRED_BEYOND_LEGACY_WINDOW";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BacktraceAction {
    PairBlocks,
    SkipScoreBlock,
    SkipPerformedBlock,
}

struct OnsetBlock<'a, T> {
    items: Vec<&'a T>,
    onset: f64,
}

/// One confirmed in-block assignment with its own diagnostics.
struct BlockPair {
    score_index: usize,
    performed_index: usize,
    kind: AlignmentKind,
    onset_error_ms: f64,
    match_cost: f64,
    ambiguous: bool,
}

struct BlockAssignment {
    pairs: Vec<BlockPair>,
    /// Indices of unpaired scores (missed), ascending.
    missed: Vec<usize>,
    /// Indices of unpaired performed notes (extra), ascending.
    extras: Vec<usize>,
    total_cost: f64,
    ambiguous_group: Option<AmbiguousGroupV2>,
}

fn note_pair_cost(score_pitch: u8, performed_pitch: u8, delta_ms: f64, dp_config: &AlignmentDpConfigV1) -> f64 {
    // Soft time cost: never hard-rejects, just grows (capped). A pitch
    // mismatch pays a finite surcharge so real wrong notes stay identified
    // as wrong-pitch pairs rather than being split into miss+extra.
    let time_cost = (delta_ms.abs() / dp_config.time_tau_ms).min(dp_config.time_cost_cap);
    if score_pitch == performed_pitch {
        time_cost
    } else {
        dp_config.pitch_mismatch_cost + time_cost
    }
}

/// Exact min-cost assignment inside one onset block. Every score pairs at most
/// one performed note or misses (`miss_cost`); every performed note may stay
/// unpaired (`extra_cost`). Solved with a subset DP over performed masks —
/// blocks are capped at `max_block_notes` (≤ 16), so the mask table is small.
/// Determinism: masks and bit positions are iterated ascending and updates use
/// strict `<`, so equal-cost alternatives always resolve to the first-checked
/// (miss before pair within a score, lowest performed index within a mask).
fn assign_block(
    score_block: &[&ScoreEvent],
    performed_block: &[&PerformedNoteV1],
    dp_config: &AlignmentDpConfigV1,
) -> BlockAssignment {
    let n = score_block.len();
    let m = performed_block.len();
    let masks = 1usize << m;

    let mut cost = vec![vec![0.0f64; m]; n];
    for (i, score_event) in score_block.iter().enumerate() {
        for (j, note) in performed_block.iter().enumerate() {
            cost[i][j] = note_pair_cost(
                score_event.pitch,
                note.pitch,
                note.onset_ms - score_event.target_onset_ms,
                dp_config,
            );
        }
    }

    let inf = f64::INFINITY;
    // f[i][mask]: min cost assigning the first i scores with EXACTLY `mask`
    // as the set of used performed notes. |mask| ≤ i always holds.
    let mut f = vec![vec![inf; masks]; n + 1];
    // (encoded_j, parent_mask); encoded_j = -1 means "score i-1 missed".
    let mut choice = vec![vec![(-1i64, 0usize); masks]; n + 1];
    f[0][0] = 0.0;
    for i in 1..=n {
        for mask in 0..masks {
            let miss = f[i - 1][mask] + dp_config.miss_cost;
            if miss.is_finite() && miss < f[i][mask] {
                f[i][mask] = miss;
                choice[i][mask] = (-1, mask);
            }
            let mut rest = mask;
            while rest != 0 {
                let j = rest.trailing_zeros() as usize;
                rest &= rest - 1;
                let prev_mask = mask & !(1usize << j);
                let prev = f[i - 1][prev_mask];
                if prev.is_finite() {
                    let candidate = prev + cost[i - 1][j];
                    if candidate < f[i][mask] {
                        f[i][mask] = candidate;
                        choice[i][mask] = (j as i64, prev_mask);
                    }
                }
            }
        }
    }

    let mut best_mask = 0usize;
    let mut best_total = inf;
    for mask in 0..masks {
        if !f[n][mask].is_finite() {
            continue;
        }
        let unpaired_count = m - mask.count_ones() as usize;
        let total = f[n][mask] + dp_config.extra_cost * unpaired_count as f64;
        if total < best_total {
            best_total = total;
            best_mask = mask;
        }
    }

    let mut pairs = Vec::new();
    let mut missed = Vec::new();
    let mut mask = best_mask;
    let mut i = n;
    while i > 0 {
        let (encoded_j, parent_mask) = choice[i][mask];
        if encoded_j < 0 {
            missed.push(i - 1);
        } else {
            let j = encoded_j as usize;
            let score_event = score_block[i - 1];
            let note = performed_block[j];
            pairs.push(BlockPair {
                score_index: i - 1,
                performed_index: j,
                kind: if note.pitch == score_event.pitch { AlignmentKind::CorrectPitch } else { AlignmentKind::WrongPitch },
                onset_error_ms: note.onset_ms - score_event.target_onset_ms,
                match_cost: cost[i - 1][j],
                ambiguous: false,
            });
            mask = parent_mask;
        }
        i -= 1;
    }
    pairs.reverse();
    missed.reverse();
    let extras: Vec<usize> = (0..m).filter(|j| best_mask & (1usize << j) == 0).collect();

    // Ambiguity: pitches with >= ambiguous_same_pitch_min notes on BOTH sides
    // make the specific within-pitch pairing unobservable. The deterministic
    // assignment is still reported; the group documents the ambiguity.
    let mut score_pitch_hist: BTreeMap<u8, usize> = BTreeMap::new();
    for score_event in score_block {
        *score_pitch_hist.entry(score_event.pitch).or_default() += 1;
    }
    let mut performed_pitch_hist: BTreeMap<u8, usize> = BTreeMap::new();
    for note in performed_block {
        *performed_pitch_hist.entry(note.pitch).or_default() += 1;
    }
    let mut ambiguous_group: Option<AmbiguousGroupV2> = None;
    for (pitch, score_count) in &score_pitch_hist {
        let performed_count = performed_pitch_hist.get(pitch).copied().unwrap_or(0);
        if score_count < &dp_config.ambiguous_same_pitch_min || performed_count < dp_config.ambiguous_same_pitch_min {
            continue;
        }
        for pair in &mut pairs {
            if pair.kind == AlignmentKind::CorrectPitch && score_block[pair.score_index].pitch == *pitch {
                pair.ambiguous = true;
            }
        }
        let group = AmbiguousGroupV2 {
            score_event_ids: score_block.iter().filter(|event| event.pitch == *pitch).map(|event| event.score_event_id.clone()).collect(),
            performed_note_ids: performed_block.iter().filter(|note| note.pitch == *pitch).map(|note| note.performed_note_id.clone()).collect(),
            reason_code: SAME_PITCH_ASSIGNMENT_AMBIGUOUS.to_string(),
        };
        match &mut ambiguous_group {
            None => ambiguous_group = Some(group),
            Some(existing) => {
                existing.score_event_ids.extend(group.score_event_ids);
                existing.performed_note_ids.extend(group.performed_note_ids);
            }
        }
    }

    BlockAssignment { pairs, missed, extras, total_cost: best_total, ambiguous_group }
}

fn group_onset_blocks<'a, T>(mut sorted: Vec<&'a T>, onset_of: impl Fn(&T) -> f64, epsilon: f64) -> Vec<OnsetBlock<'a, T>> {
    let mut blocks: Vec<OnsetBlock<'a, T>> = Vec::new();
    for item in sorted.drain(..) {
        let onset = onset_of(item);
        match blocks.last_mut() {
            Some(block) if (onset - block.onset).abs() <= epsilon => block.items.push(item),
            _ => blocks.push(OnsetBlock { items: vec![item], onset }),
        }
    }
    blocks
}

fn resource_limit_result(reason_detail: String, dp_config: &AlignmentDpConfigV1) -> AlignmentResultV2 {
    AlignmentResultV2 {
        diagnostics: vec![AlignmentDiagnosticV2 {
            code: ALIGNMENT_RESOURCE_LIMIT.to_string(),
            score_event_ids: Vec::new(),
            performed_note_ids: Vec::new(),
            detail: reason_detail,
        }],
        status: AlignmentStatusV2::ResourceLimit { reason_code: ALIGNMENT_RESOURCE_LIMIT.to_string() },
        algorithm_version: ALIGNMENT_DP_V2_ALGORITHM_VERSION.to_string(),
        parameter_fingerprint: dp_config.parameter_fingerprint(),
        ..AlignmentResultV2::default()
    }
}

/// Weighted sequence alignment candidate (PRD §4.2 `WeightedSequenceAlignerV2`).
///
/// Block-level banded DP over onset groups: every transition is either a
/// block pair (with an exact in-block min-cost assignment that absorbs
/// partial misses/extras/wrong pitches), a fully missed score block, or a
/// fully extra performed block. Time is a SOFT cost — nothing is hard-rejected
/// for being late. Row storage is a prefix up to each row's band edge, which
/// is exact: any pairing transition's predecessor is by definition within the
/// previous row's band, and extra chains commute across rows.
pub fn align_performances_dp_v2(
    score_events: &[ScoreEvent],
    performed: &[PerformedNoteV1],
    config: &ScoringConfig,
    dp_config: &AlignmentDpConfigV1,
) -> Result<AlignmentResultV2, CoreError> {
    dp_config.validate()?;
    for event in score_events {
        if !event.target_onset_ms.is_finite() || event.target_onset_ms < 0.0 {
            return Err(CoreError::InvalidEvent("score target onset must be finite and >= 0".into()));
        }
    }

    let mut targets_sorted: Vec<&ScoreEvent> = score_events.iter().filter(|e| e.target_onset_ms.is_finite()).collect();
    targets_sorted.sort_by(|a, b| a.target_onset_ms.total_cmp(&b.target_onset_ms).then(a.score_event_id.cmp(&b.score_event_id)));
    let mut performed_sorted: Vec<&PerformedNoteV1> = performed.iter().collect();
    performed_sorted.sort_by(|a, b| a.onset_ms.total_cmp(&b.onset_ms).then(a.performed_note_id.cmp(&b.performed_note_id)));

    let score_blocks = group_onset_blocks(targets_sorted, |e| e.target_onset_ms, dp_config.same_onset_epsilon_ms);
    let performed_blocks = group_onset_blocks(performed_sorted, |n| n.onset_ms, dp_config.performed_spread_epsilon_ms);
    let g_count = score_blocks.len();
    let h_count = performed_blocks.len();

    let oversized_count = score_blocks
        .iter()
        .map(|block| block.items.len())
        .chain(performed_blocks.iter().map(|block| block.items.len()))
        .find(|count| *count > dp_config.max_block_notes);
    if let Some(count) = oversized_count {
        return Ok(resource_limit_result(
            format!("onset block holds {count} notes, above max_block_notes {}", dp_config.max_block_notes),
            dp_config,
        ));
    }

    // Row widths. Row r stores cells [0..=hi[r]]; a pair transition in row r
    // reads (r-1, h-1) where h-1 is by definition within score block r-1's
    // band, so row r-1 must store up to THAT band edge: width_r-1 = pointer
    // computed from the NEXT score block's onset. Since block onsets are
    // sorted, the pointers are monotone and a two-pointer sweep computes them.
    let mut hi = vec![0usize; g_count + 1];
    {
        // pointer_after[g] = number of performed blocks within band of score
        // block g-1 (1-based rows). pointer_after[0] serves row 0's width.
        let mut pointer_after = vec![0usize; g_count + 1];
        let mut pointer = 0usize;
        for g in 0..=g_count {
            if g == 0 {
                pointer_after[0] = if g_count == 0 { h_count } else { 0 };
                continue;
            }
            let onset = score_blocks[g - 1].onset;
            while pointer < h_count && performed_blocks[pointer].onset <= onset + dp_config.band_ms {
                pointer += 1;
            }
            pointer_after[g] = pointer;
        }
        for r in 0..=g_count {
            // Intermediate rows only serve as pair predecessors for the NEXT
            // row (cells up to that row's band edge). The final row must hold
            // the terminal cell (G, H) itself, so it stores the full width —
            // its extra suffix chain is linear and cheap.
            let source = if r < g_count { pointer_after[r + 1] } else { h_count + 1 };
            hi[r] = source.saturating_sub(1);
        }
    }
    let mut evaluated_cells: u64 = 0;
    for r in 0..=g_count {
        evaluated_cells += hi[r] as u64 + 1;
    }
    if evaluated_cells > dp_config.max_cells {
        return Ok(resource_limit_result(
            format!("banded dp evaluates {evaluated_cells} cells, above max_cells {}", dp_config.max_cells),
            dp_config,
        ));
    }

    let inf = f64::INFINITY;
    let miss_all = |g: usize| dp_config.miss_cost * score_blocks[g].items.len() as f64;
    let extra_all = |h: usize| dp_config.extra_cost * performed_blocks[h].items.len() as f64;

    let mut rows: Vec<Vec<f64>> = Vec::with_capacity(g_count + 1);
    let mut parents: Vec<Vec<BacktraceAction>> = Vec::with_capacity(g_count + 1);
    let mut assignment_cache: HashMap<(usize, usize), BlockAssignment> = HashMap::new();

    for r in 0..=g_count {
        let width = hi[r] + 1;
        let mut row = vec![inf; width];
        let mut parent = vec![BacktraceAction::SkipPerformedBlock; width];
        if r == 0 {
            // Every score missed; performed blocks are a prefix of extras.
            row[0] = 0.0;
            for h in 1..width {
                row[h] = row[h - 1] + extra_all(h - 1);
                parent[h] = BacktraceAction::SkipPerformedBlock;
            }
        } else {
            let onset = score_blocks[r - 1].onset;
            for h in 0..width {
                // pair: score block r-1 with performed block h-1
                if h > 0 && (performed_blocks[h - 1].onset - onset).abs() <= dp_config.band_ms {
                    let prev = rows[r - 1][h - 1];
                    if prev.is_finite() {
                        let assignment = assignment_cache
                            .entry((r - 1, h - 1))
                            .or_insert_with(|| assign_block(&score_blocks[r - 1].items, &performed_blocks[h - 1].items, dp_config));
                        let candidate = prev + assignment.total_cost;
                        if candidate < row[h] {
                            row[h] = candidate;
                            parent[h] = BacktraceAction::PairBlocks;
                        }
                    }
                }
                // skip score block r-1 (all its notes missed)
                let prev_score = if h <= hi[r - 1] { rows[r - 1][h] } else { inf };
                if prev_score.is_finite() {
                    let candidate = prev_score + miss_all(r - 1);
                    if candidate < row[h] {
                        row[h] = candidate;
                        parent[h] = BacktraceAction::SkipScoreBlock;
                    }
                }
                // extra chain: performed block h-1 skipped
                if h > 0 {
                    let candidate = row[h - 1] + extra_all(h - 1);
                    if candidate < row[h] {
                        row[h] = candidate;
                        parent[h] = BacktraceAction::SkipPerformedBlock;
                    }
                }
            }
        }
        rows.push(row);
        parents.push(parent);
    }

    let mut result = AlignmentResultV2 {
        algorithm_version: ALIGNMENT_DP_V2_ALGORITHM_VERSION.to_string(),
        parameter_fingerprint: dp_config.parameter_fingerprint(),
        ..AlignmentResultV2::default()
    };

    // Backtrace. Performed blocks beyond the final row's stored edge are
    // extras by construction (extra chains commute across rows, so the tail
    // walk reproduces exactly the omitted prefix-sum cells).
    let mut actions: Vec<(usize, usize, BacktraceAction)> = Vec::new();
    let (mut r, mut h) = (g_count, h_count);
    while r > 0 || h > 0 {
        if h > hi[r] {
            actions.push((r, h, BacktraceAction::SkipPerformedBlock));
            h -= 1;
            continue;
        }
        let action = parents[r][h];
        actions.push((r, h, action));
        match action {
            BacktraceAction::PairBlocks => {
                r -= 1;
                h -= 1;
            }
            BacktraceAction::SkipScoreBlock => r -= 1,
            BacktraceAction::SkipPerformedBlock => h -= 1,
        }
    }
    actions.reverse();

    for (r, h, action) in actions {
        match action {
            BacktraceAction::PairBlocks => {
                let mut assignment = assignment_cache.remove(&(r - 1, h - 1)).expect("paired blocks must be cached");
                let score_block = &score_blocks[r - 1];
                let performed_block = &performed_blocks[h - 1];
                for pair in assignment.pairs.iter() {
                    let score_event = score_block.items[pair.score_index];
                    let note = performed_block.items[pair.performed_index];
                    result.pairs.push(AlignmentPairV2 {
                        score_event_id: score_event.score_event_id.clone(),
                        performed_note_id: note.performed_note_id.clone(),
                        kind: pair.kind,
                        onset_error_ms: pair.onset_error_ms,
                        match_cost: pair.match_cost,
                        assignment_ambiguous: pair.ambiguous,
                        measure: score_event.measure,
                    });
                    if pair.onset_error_ms.abs() > config.max_onset_deviation_ms {
                        result.diagnostics.push(AlignmentDiagnosticV2 {
                            code: LATE_BUT_PAIRED_BEYOND_LEGACY_WINDOW.to_string(),
                            score_event_ids: vec![score_event.score_event_id.clone()],
                            performed_note_ids: vec![note.performed_note_id.clone()],
                            detail: format!(
                                "paired with raw error {:.1} ms beyond the legacy +-{:.0} ms window",
                                pair.onset_error_ms, config.max_onset_deviation_ms
                            ),
                        });
                    }
                }
                for index in &assignment.missed {
                    result.missed_score_event_ids.push(score_block.items[*index].score_event_id.clone());
                }
                for index in &assignment.extras {
                    result.extra_performed_ids.push(performed_block.items[*index].performed_note_id.clone());
                }
                if let Some(group) = assignment.ambiguous_group.take() {
                    result.ambiguous_groups.push(group);
                }
            }
            BacktraceAction::SkipScoreBlock => {
                for event in &score_blocks[r - 1].items {
                    result.missed_score_event_ids.push(event.score_event_id.clone());
                }
            }
            BacktraceAction::SkipPerformedBlock => {
                for note in &performed_blocks[h - 1].items {
                    result.extra_performed_ids.push(note.performed_note_id.clone());
                }
            }
        }
    }

    validate_alignment_result_v2(&result, score_events, performed)?;
    Ok(result)
}

/// Maps a V2 result onto the frozen legacy alignment shape so the shared
/// `score_with_alignment` report builder can consume it. `rest_window_extra_ids`
/// keep their v1 semantics: extras strictly between two consecutive matched
/// onsets.
pub fn to_legacy_alignment(result: &AlignmentResultV2, performed: &[PerformedNoteV1]) -> AlignmentResult {
    let performed_by_id: HashMap<&str, &PerformedNoteV1> = performed
        .iter()
        .map(|note| (note.performed_note_id.as_str(), note))
        .collect();
    let mut matched_onsets: Vec<f64> = result
        .pairs
        .iter()
        .filter_map(|pair| performed_by_id.get(pair.performed_note_id.as_str()).map(|note| note.onset_ms))
        .collect();
    matched_onsets.sort_by(f64::total_cmp);

    let mut legacy = AlignmentResult {
        pairs: result
            .pairs
            .iter()
            .map(|pair| AlignmentPair {
                score_event_id: pair.score_event_id.clone(),
                performed_note_id: pair.performed_note_id.clone(),
                pitch_matched: pair.kind == AlignmentKind::CorrectPitch,
                onset_error_ms: pair.onset_error_ms,
                measure: pair.measure,
            })
            .collect(),
        missed_score_event_ids: result.missed_score_event_ids.clone(),
        extra_performed_ids: result.extra_performed_ids.clone(),
        rest_window_extra_ids: Vec::new(),
    };
    for extra_id in &result.extra_performed_ids {
        if let Some(note) = performed_by_id.get(extra_id.as_str()) {
            for window in matched_onsets.windows(2) {
                if note.onset_ms > window[0] && note.onset_ms < window[1] {
                    legacy.rest_window_extra_ids.push(extra_id.clone());
                    break;
                }
            }
        }
    }
    legacy
}
