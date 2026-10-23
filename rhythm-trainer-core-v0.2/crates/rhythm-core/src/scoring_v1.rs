//! Rhythm Trainer scoring engine v1.0 (spec: docs/SCORING-REQUIREMENTS-v1.0.md).
//!
//! Design contracts (spec §6/§11):
//! - Onset error, inter-onset interval and key-down duration are THREE
//!   separate measurements and never substitute each other.
//! - Raw sub-metrics are always reported alongside any 0–100 summary.
//! - Missing data excludes a sub-score and renormalizes the remaining
//!   weights — never scored as 0 or 100.
//! - Every diagnostic carries metric evidence and event ids.
//! - Deterministic: same inputs + config + version ⇒ same report.

use crate::CoreError;
use std::collections::BTreeMap;

pub const SCORING_ALGORITHM_VERSION: &str = "scoring-v1.0.0";

// ---------------------------------------------------------------------------
// Versioned configuration (spec §7.2/§8: no magic numbers outside here).

#[derive(Debug, Clone, PartialEq)]
pub struct ScoringConfig {
    /// Onset deviations beyond this can never pair (drives miss/extra split).
    pub max_onset_deviation_ms: f64,
    /// Onset abs error within this counts as "in tolerance" (relaxed default).
    pub onset_tolerance_ms: f64,
    pub pitch_mismatch_penalty: f64,
    pub miss_penalty: f64,
    pub extra_penalty: f64,
    /// Matched-pair sample minimum for high-confidence rhythm claims.
    pub min_rhythm_samples: usize,
    /// |median signed onset error| at or above this (with low jitter) is a
    /// global-offset diagnostic rather than instability.
    pub global_offset_ms: f64,
    /// MAD of IOI speed-ratio at/above this is local jitter.
    pub jitter_ratio_mad: f64,
    /// Least-squares speed-ratio slope (per target index) at/above this is drift.
    pub drift_ratio_slope: f64,
    pub duration_tolerance_ms: f64,
    pub duration_tolerance_ratio: f64,
    /// Sub-score weights; must sum > 0. Renormalized when a sub-score is unscored.
    pub weights: ScoreWeights,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScoreWeights {
    pub pitch: f64,
    pub onset: f64,
    pub rhythm: f64,
    pub duration: f64,
    pub continuity: f64,
}

impl Default for ScoreWeights {
    fn default() -> Self {
        // Spec §6.6 defaults: pitch 30 / onset 20 / rhythm 30 / duration 15 / continuity 5.
        Self { pitch: 30.0, onset: 20.0, rhythm: 30.0, duration: 15.0, continuity: 5.0 }
    }
}

impl Default for ScoringConfig {
    fn default() -> Self {
        Self {
            max_onset_deviation_ms: 250.0,
            onset_tolerance_ms: 60.0,
            pitch_mismatch_penalty: 3.0,
            miss_penalty: 4.0,
            extra_penalty: 2.5,
            min_rhythm_samples: 4,
            global_offset_ms: 30.0,
            jitter_ratio_mad: 0.08,
            drift_ratio_slope: 0.01,
            duration_tolerance_ms: 50.0,
            duration_tolerance_ratio: 0.15,
            weights: ScoreWeights::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// Inputs

#[derive(Debug, Clone, PartialEq)]
pub struct ScoreEvent {
    pub score_event_id: String,
    pub measure: u32,
    /// Score position in beats from the start (from integer ticks; f64 holds
    /// ticks exactly for realistic scores — rational type is a future upgrade).
    pub beat_position: f64,
    pub pitch: u8,
    /// Target onset in ms on the practice tempo map.
    pub target_onset_ms: f64,
    /// Nominal sounding duration in ms (tie group merged upstream).
    pub target_duration_ms: f64,
    pub part_id: String,
    /// Capability/parse metadata carried through to the report.
    pub parse_confidence: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PerformedNoteV1 {
    pub performed_note_id: String,
    pub pitch: u8,
    pub onset_ms: f64,
    /// None when the key never released (missing/interrupted) — duration unknown.
    pub release_ms: Option<f64>,
    pub pairing_status: PairingStatusV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingStatusV1 {
    Complete,
    MissingRelease,
    Ambiguous,
    InvalidTime,
}

// ---------------------------------------------------------------------------
// Alignment: monotonic greedy matcher with pitch lookahead (spec §5.2 allows
// "等效算法"; full DP is the future upgrade once traces grow into tens of
// thousands of events). Deterministic; handles missing/extra/wrong/chords.

#[derive(Debug, Clone, PartialEq)]
pub struct AlignmentPair {
    pub score_event_id: String,
    pub performed_note_id: String,
    pub pitch_matched: bool,
    pub onset_error_ms: f64,
    pub measure: u32,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct AlignmentResult {
    pub pairs: Vec<AlignmentPair>,
    pub missed_score_event_ids: Vec<String>,
    pub extra_performed_ids: Vec<String>,
    /// Extra onsets that fall inside a target gap (rest window approximation).
    pub rest_window_extra_ids: Vec<String>,
}

pub fn align_performances(
    score_events: &[ScoreEvent],
    performed: &[PerformedNoteV1],
    config: &ScoringConfig,
) -> Result<AlignmentResult, CoreError> {
    for event in score_events {
        if !event.target_onset_ms.is_finite() || event.target_onset_ms < 0.0 {
            return Err(CoreError::InvalidEvent("score target onset must be finite and >= 0".into()));
        }
    }
    let mut targets: Vec<&ScoreEvent> = score_events.iter().filter(|e| e.target_onset_ms.is_finite()).collect();
    targets.sort_by(|a, b| a.target_onset_ms.total_cmp(&b.target_onset_ms));
    let mut performed_sorted: Vec<&PerformedNoteV1> = performed.iter().collect();
    performed_sorted.sort_by(|a, b| a.onset_ms.total_cmp(&b.onset_ms).then(a.performed_note_id.cmp(&b.performed_note_id)));

    let mut result = AlignmentResult::default();
    let mut i = 0usize; // target cursor
    let mut j = 0usize; // performed cursor
    let max_dev = config.max_onset_deviation_ms;
    let same_onset_epsilon = 0.001_f64;
    let mut consumed = vec![false; performed_sorted.len()];

    while i < targets.len() && j < performed_sorted.len() {
        let target = targets[i];
        let note = performed_sorted[j];
        let delta = note.onset_ms - target.target_onset_ms;

        // Notes with the same target onset are simultaneous, not a sequence.
        // Match that group by pitch before advancing the monotonic cursors:
        // a human chord is routinely spread by a few milliseconds and may
        // arrive in any pitch order. Without this branch the greedy cursor
        // misreads a same-onset chord as missing/wrong/extra notes.
        let group_size = targets[i..]
            .iter()
            .take_while(|t| (t.target_onset_ms - target.target_onset_ms).abs() <= same_onset_epsilon)
            .count();
        if group_size > 1 {
            while j < performed_sorted.len() && performed_sorted[j].onset_ms < target.target_onset_ms - max_dev {
                if !consumed[j] {
                    result.extra_performed_ids.push(performed_sorted[j].performed_note_id.clone());
                    consumed[j] = true;
                }
                j += 1;
            }
            let candidate_start = j;
            // A note at or after the next distinct target onset belongs to
            // that next target, not to this chord's fallback window.
            let next_onset = targets
                .get(i + group_size)
                .map(|next| next.target_onset_ms)
                .unwrap_or(f64::INFINITY);
            let candidate_stop = (target.target_onset_ms + max_dev).min(next_onset);
            let mut candidate_end = j;
            while candidate_end < performed_sorted.len()
                && performed_sorted[candidate_end].onset_ms < candidate_stop
            {
                candidate_end += 1;
            }
            if candidate_start == candidate_end {
                for group_target in &targets[i..i + group_size] {
                    result.missed_score_event_ids.push(group_target.score_event_id.clone());
                }
                i += group_size;
                continue;
            }
            for group_target in &targets[i..i + group_size] {
                let mut best: Option<usize> = None;
                let mut best_error = f64::INFINITY;
                for candidate in candidate_start..candidate_end {
                    if consumed[candidate] || performed_sorted[candidate].pitch != group_target.pitch {
                        continue;
                    }
                    let error = (performed_sorted[candidate].onset_ms - group_target.target_onset_ms).abs();
                    if error < best_error {
                        best = Some(candidate);
                        best_error = error;
                    }
                }
                let pair_index = if let Some(candidate) = best {
                    Some(candidate)
                } else {
                    // No same-pitch note: keep the closest remaining note in
                    // the window so a wrong chord pitch is reported as such.
                    let mut fallback: Option<usize> = None;
                    let mut fallback_error = f64::INFINITY;
                    for candidate in candidate_start..candidate_end {
                        if consumed[candidate] {
                            continue;
                        }
                        let error = (performed_sorted[candidate].onset_ms - group_target.target_onset_ms).abs();
                        if error < fallback_error {
                            fallback = Some(candidate);
                            fallback_error = error;
                        }
                    }
                    fallback
                };
                if let Some(candidate) = pair_index {
                    let matched_note = performed_sorted[candidate];
                    consumed[candidate] = true;
                    result.pairs.push(AlignmentPair {
                        score_event_id: group_target.score_event_id.clone(),
                        performed_note_id: matched_note.performed_note_id.clone(),
                        pitch_matched: matched_note.pitch == group_target.pitch,
                        onset_error_ms: matched_note.onset_ms - group_target.target_onset_ms,
                        measure: group_target.measure,
                    });
                } else {
                    result.missed_score_event_ids.push(group_target.score_event_id.clone());
                }
            }
            for candidate in candidate_start..candidate_end {
                if !consumed[candidate] {
                    result.extra_performed_ids.push(performed_sorted[candidate].performed_note_id.clone());
                    consumed[candidate] = true;
                }
            }
            i += group_size;
            j = candidate_end;
            continue;
        }

        if delta < -max_dev {
            // Performed note is far earlier than this target: it cannot belong
            // to it (or any later target) — an extra.
            result.extra_performed_ids.push(note.performed_note_id.clone());
            j += 1;
            continue;
        }
        if delta > max_dev {
            // No performed note near this target: missed.
            result.missed_score_event_ids.push(target.score_event_id.clone());
            i += 1;
            continue;
        }
        // Within the pairing window: prefer matching pitch; a small lookahead
        // (chord/repeat scale) decides whether skipping is the better story.
        let pitch_equal = note.pitch == target.pitch;
        if pitch_equal {
            result.pairs.push(AlignmentPair {
                score_event_id: target.score_event_id.clone(),
                performed_note_id: note.performed_note_id.clone(),
                pitch_matched: true,
                onset_error_ms: delta,
                measure: target.measure,
            });
            i += 1;
            j += 1;
            continue;
        }
        let lookahead_target_has_pitch = targets.iter().skip(i + 1).take(4)
            .any(|t| t.pitch == note.pitch && (note.onset_ms - t.target_onset_ms).abs() <= max_dev);
        let lookahead_performed_has_pitch = performed_sorted.iter().skip(j + 1).take(4)
            .any(|p| p.pitch == target.pitch && (p.onset_ms - target.target_onset_ms).abs() <= max_dev);
        if lookahead_target_has_pitch {
            // This performed note belongs to a later target — current is missed.
            result.missed_score_event_ids.push(target.score_event_id.clone());
            i += 1;
        } else if lookahead_performed_has_pitch {
            // The matching performed note comes shortly — this one is extra.
            result.extra_performed_ids.push(note.performed_note_id.clone());
            j += 1;
        } else {
            // Wrong pitch within the window: pair it (monotonic progress) and
            // report the pitch mismatch — never silently drop it.
            result.pairs.push(AlignmentPair {
                score_event_id: target.score_event_id.clone(),
                performed_note_id: note.performed_note_id.clone(),
                pitch_matched: false,
                onset_error_ms: delta,
                measure: target.measure,
            });
            i += 1;
            j += 1;
        }
    }
    while i < targets.len() {
        result.missed_score_event_ids.push(targets[i].score_event_id.clone());
        i += 1;
    }
    while j < performed_sorted.len() {
        result.extra_performed_ids.push(performed_sorted[j].performed_note_id.clone());
        j += 1;
    }

    // Rest-window extras: extras whose onset falls strictly between two
    // consecutive matched targets (a structural gap), not before/after the piece.
    let matched_onsets: Vec<f64> = result.pairs.iter()
        .filter_map(|pair| {
            score_events.iter().find(|e| e.score_event_id == pair.score_event_id).map(|e| e.target_onset_ms)
        })
        .collect();
    for extra_id in &result.extra_performed_ids {
        if let Some(note) = performed_sorted.iter().find(|p| p.performed_note_id == *extra_id) {
            for window in matched_onsets.windows(2) {
                if note.onset_ms > window[0] && note.onset_ms < window[1] {
                    result.rest_window_extra_ids.push(extra_id.clone());
                    break;
                }
            }
        }
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// Metrics (raw values first; scores are derived summaries).

#[derive(Debug, Clone, PartialEq, Default)]
pub struct OnsetMetrics {
    pub matched: usize,
    pub signed_mean_ms: Option<f64>,
    pub signed_median_ms: Option<f64>,
    pub mean_absolute_ms: Option<f64>,
    pub p50_absolute_ms: Option<f64>,
    pub p90_absolute_ms: Option<f64>,
    pub out_of_tolerance_count: usize,
    pub out_of_tolerance_ratio: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct RhythmMetrics {
    /// Consecutive matched-pair intervals; None where the next target is unmatched.
    pub interval_samples: usize,
    pub mean_speed_ratio: Option<f64>,
    /// MAD of speed ratios — local jitter (unitless; 1.0 = on grid).
    pub jitter_ratio_mad: Option<f64>,
    /// Least-squares slope of speed ratio per target index; + = slowing down.
    pub drift_ratio_slope_per_index: Option<f64>,
    pub rhythm_compensation_suspected: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct DurationMetrics {
    pub graded: usize,
    pub mean_ratio: Option<f64>,
    pub too_short_count: usize,
    pub too_long_count: usize,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ContinuityMetrics {
    pub covered_ratio: Option<f64>,
    pub longest_matched_streak: usize,
    pub measures_total: usize,
    pub measures_with_any_match: usize,
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() { return None; }
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    Some(if values.len() % 2 == 0 { (values[mid - 1] + values[mid]) / 2.0 } else { values[mid] })
}

fn percentile(values: &mut Vec<f64>, p: f64) -> Option<f64> {
    if values.is_empty() { return None; }
    values.sort_by(f64::total_cmp);
    let idx = (((values.len() - 1) as f64) * p).round() as usize;
    Some(values[idx])
}

fn mad(values: &[f64]) -> Option<f64> {
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let mut deviations: Vec<f64> = values.iter().map(|v| (v - mean).abs()).collect();
    median(deviations)
}

/// Least-squares slope of y over index x.
fn slope(points: &[(f64, f64)]) -> Option<f64> {
    let n = points.len() as f64;
    if n < 2.0 { return None; }
    let mean_x = points.iter().map(|p| p.0).sum::<f64>() / n;
    let mean_y = points.iter().map(|p| p.1).sum::<f64>() / n;
    let mut num = 0.0;
    let mut den = 0.0;
    for (x, y) in points {
        num += (x - mean_x) * (y - mean_y);
        den += (x - mean_x) * (x - mean_x);
    }
    if den.abs() <= f64::EPSILON { None } else { Some(num / den) }
}

// ---------------------------------------------------------------------------
// Per-measure roll-up (spec §6.2 分小节 / §6.3 热力图 data source).

#[derive(Debug, Clone, PartialEq, Default)]
pub struct MeasureRollup {
    pub measure: u32,
    pub matched: usize,
    pub missed: usize,
    pub mean_abs_onset_error_ms: Option<f64>,
    pub mean_speed_ratio: Option<f64>,
}

// ---------------------------------------------------------------------------
// Diagnostics with evidence chains (spec §8).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    High,
    Medium,
    Low,
    NotAssessable,
}

impl Confidence {
    pub fn as_str(self) -> &'static str {
        match self { Self::High => "high", Self::Medium => "medium", Self::Low => "low", Self::NotAssessable => "not-assessable" }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Diagnostic {
    pub category: &'static str,
    pub severity: &'static str,
    pub measure_range: Option<(u32, u32)>,
    /// Human-readable evidence: metric name, value, sample count, threshold.
    pub evidence: String,
    pub confidence: Confidence,
    pub suggested_action: String,
    pub score_event_ids: Vec<String>,
    pub performed_event_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// Sub-scores with missing-data renormalization (spec §6.6 / acceptance L).

#[derive(Debug, Clone, PartialEq)]
pub struct SubScore {
    pub name: &'static str,
    /// None = unscored (no samples / not applicable) — excluded from weighting.
    pub score: Option<f64>,
    pub weight: f64,
    pub sample_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OverallScore {
    pub score: Option<f64>,
    pub subscores: Vec<SubScore>,
    pub renormalized: bool,
}

fn compute_overall(subscores: Vec<SubScore>) -> OverallScore {
    let mut weight_sum = 0.0;
    let mut weighted = 0.0;
    let mut renormalized = false;
    for sub in &subscores {
        match sub.score {
            Some(value) => {
                weight_sum += sub.weight;
                weighted += value * sub.weight;
            }
            None => renormalized = true,
        }
    }
    let score = if weight_sum > 0.0 { Some(weighted / weight_sum) } else { None };
    OverallScore { score, subscores, renormalized }
}

// ---------------------------------------------------------------------------
// Full report assembly.

#[derive(Debug, Clone, PartialEq)]
pub struct MeasureReport {
    pub measure: u32,
    pub matched: usize,
    pub missed: usize,
    pub mean_abs_onset_error_ms: Option<f64>,
    pub mean_speed_ratio: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionScoreReport {
    pub algorithm_version: String,
    pub alignment: AlignmentResult,
    pub pitch: PitchAccuracy,
    pub onset: OnsetMetrics,
    pub rhythm: RhythmMetrics,
    pub duration: DurationMetrics,
    pub continuity: ContinuityMetrics,
    pub measures: Vec<MeasureReport>,
    pub overall: OverallScore,
    pub confidence: Confidence,
    pub data_degraded: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub practice_ranges: Vec<PracticeRange>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct PitchAccuracy {
    pub targets: usize,
    pub correct: usize,
    pub wrong_pitch: usize,
    pub missed: usize,
    pub extra: usize,
    /// correct / targets (each missed target is a pitch failure for recall).
    pub recall: Option<f64>,
    /// correct / (correct + wrong + extra) — of everything actually played.
    pub precision: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PracticeRange {
    pub start_measure: u32,
    pub end_measure: u32,
    pub reason: String,
    pub priority: u8,
}

/// Scores a performance against a score model. Pure and deterministic.
pub fn score_performance(
    score_events: &[ScoreEvent],
    performed: &[PerformedNoteV1],
    config: &ScoringConfig,
) -> Result<SessionScoreReport, CoreError> {
    if config.weights.pitch + config.weights.onset + config.weights.rhythm + config.weights.duration + config.weights.continuity <= 0.0 {
        return Err(CoreError::InvalidConfig("score weights must sum > 0".into()));
    }
    for note in performed {
        if !note.onset_ms.is_finite() || note.onset_ms < 0.0 {
            return Err(CoreError::InvalidEvent("performed onset must be finite and >= 0".into()));
        }
    }
    let alignment = align_performances(score_events, performed, config)?;
    let pairs = &alignment.pairs;

    // ---- onset metrics ----
    let mut signed: Vec<f64> = Vec::new();
    let mut absolute: Vec<f64> = Vec::new();
    let mut out_of_tolerance = 0usize;
    for pair in pairs {
        signed.push(pair.onset_error_ms);
        absolute.push(pair.onset_error_ms.abs());
        if pair.onset_error_ms.abs() > config.onset_tolerance_ms {
            out_of_tolerance += 1;
        }
    }
    let matched = pairs.len();
    let onset = OnsetMetrics {
        matched,
        signed_mean_ms: if signed.is_empty() { None } else { Some(signed.iter().sum::<f64>() / signed.len() as f64) },
        signed_median_ms: median(signed.clone()),
        mean_absolute_ms: if absolute.is_empty() { None } else { Some(absolute.iter().sum::<f64>() / absolute.len() as f64) },
        p50_absolute_ms: percentile(&mut absolute.clone(), 0.5),
        p90_absolute_ms: percentile(&mut absolute, 0.9),
        out_of_tolerance_count: out_of_tolerance,
        out_of_tolerance_ratio: if matched == 0 { None } else { Some(out_of_tolerance as f64 / matched as f64) },
    };

    // ---- rhythm: local IOI / speed ratio / jitter / drift on matched pairs ----
    let by_score_id: BTreeMap<&str, &ScoreEvent> = score_events.iter()
        .map(|e| (e.score_event_id.as_str(), e)).collect();
    // x-axis = target ordinal (position in the time-sorted target list), so the
    // drift slope reads "speed-ratio change per target index".
    let mut target_ordinals: BTreeMap<&str, usize> = BTreeMap::new();
    let mut time_sorted: Vec<&ScoreEvent> = score_events.iter().collect();
    time_sorted.sort_by(|a, b| a.target_onset_ms.total_cmp(&b.target_onset_ms));
    for (ordinal, event) in time_sorted.iter().enumerate() {
        target_ordinals.insert(event.score_event_id.as_str(), ordinal);
    }
    let mut ratio_points: Vec<(f64, f64)> = Vec::new(); // (target ordinal, speed ratio)
    let mut ratio_by_ordinal: BTreeMap<usize, f64> = BTreeMap::new();
    for window in pairs.windows(2) {
        let (Some(t0), Some(t1)) = (
            by_score_id.get(window[0].score_event_id.as_str()).copied(),
            by_score_id.get(window[1].score_event_id.as_str()).copied(),
        ) else { continue };
        let (Some(p0), Some(p1)) = (
            performed.iter().find(|p| p.performed_note_id == window[0].performed_note_id),
            performed.iter().find(|p| p.performed_note_id == window[1].performed_note_id),
        ) else { continue };
        let target_ioi = t1.target_onset_ms - t0.target_onset_ms;
        if target_ioi <= 0.0 { continue; }
        let actual_ioi = p1.onset_ms - p0.onset_ms;
        if actual_ioi <= 0.0 { continue; } // degenerate interval excluded; sample count discloses
        let ordinal1 = target_ordinals.get(window[1].score_event_id.as_str()).copied().unwrap_or(0);
        ratio_by_ordinal.insert(ordinal1, actual_ioi / target_ioi);
        ratio_points.push((ordinal1 as f64, actual_ioi / target_ioi));
    }
    let ratios: Vec<f64> = ratio_points.iter().map(|p| p.1).collect();
    let rhythm_jitter = mad(&ratios);
    let drift = slope(&ratio_points);
    // Rhythm compensation: overall end alignment looks fine (small median error)
    // while local jitter is high — the "ends on time but rushed then dragged" case.
    let median_abs = onset.signed_median_ms.map(|v| v.abs()).unwrap_or(0.0);
    let compensation = matched >= config.min_rhythm_samples
        && median_abs <= config.global_offset_ms
        && rhythm_jitter.map(|j| j >= config.jitter_ratio_mad).unwrap_or(false);
    let rhythm = RhythmMetrics {
        interval_samples: ratios.len(),
        mean_speed_ratio: if ratios.is_empty() { None } else { Some(ratios.iter().sum::<f64>() / ratios.len() as f64) },
        jitter_ratio_mad: rhythm_jitter,
        drift_ratio_slope_per_index: drift,
        rhythm_compensation_suspected: compensation,
    };

    // ---- duration from valid pairing ----
    let mut duration_ratios: Vec<f64> = Vec::new();
    let mut too_short = 0usize;
    let mut too_long = 0usize;
    for pair in pairs {
        let Some(note) = performed.iter().find(|p| p.performed_note_id == pair.performed_note_id) else { continue };
        let (Some(release), PairingStatusV1::Complete) = (note.release_ms, note.pairing_status) else { continue };
        if note.onset_ms.is_nan() || release < note.onset_ms { continue; }
        let Some(target) = by_score_id.get(pair.score_event_id.as_str()) else { continue };
        if target.target_duration_ms <= 0.0 { continue; }
        let held = release - note.onset_ms;
        let allowed = config.duration_tolerance_ms.max(target.target_duration_ms * config.duration_tolerance_ratio);
        let error = held - target.target_duration_ms;
        if error < -allowed { too_short += 1; }
        if error > allowed { too_long += 1; }
        duration_ratios.push(held / target.target_duration_ms);
    }
    let duration = DurationMetrics {
        graded: duration_ratios.len(),
        mean_ratio: if duration_ratios.is_empty() { None } else { Some(duration_ratios.iter().sum::<f64>() / duration_ratios.len() as f64) },
        too_short_count: too_short,
        too_long_count: too_long,
    };

    // ---- continuity / coverage ----
    let measures_total = score_events.iter().map(|e| e.measure).max().unwrap_or(0);
    let mut matched_measures: std::collections::BTreeSet<u32> = Default::default();
    let mut longest_streak = 0usize;
    let mut current_streak = 0usize;
    let mut per_measure: BTreeMap<u32, Vec<Option<&AlignmentPair>>> = BTreeMap::new();
    for event in score_events {
        per_measure.entry(event.measure).or_default().push(pairs.iter().find(|p| p.score_event_id == event.score_event_id));
    }
    for (_, slots) in &per_measure {
        for slot in slots {
            if slot.is_some() { current_streak += 1; longest_streak = longest_streak.max(current_streak); }
            else { current_streak = 0; }
        }
    }
    for pair in pairs {
        matched_measures.insert(pair.measure);
    }
    let continuity = ContinuityMetrics {
        covered_ratio: if score_events.is_empty() { None } else { Some(pairs.len() as f64 / score_events.len() as f64) },
        longest_matched_streak: longest_streak,
        measures_total: measures_total as usize,
        measures_with_any_match: matched_measures.len(),
    };

    // ---- per-measure rollup ----
    let mut measures: Vec<MeasureReport> = Vec::new();
    for (measure_value, slots) in &per_measure {
        let matched_count = slots.iter().filter(|s| s.is_some()).count();
        let missed_count = slots.iter().filter(|s| s.is_none()).count();
        let errors: Vec<f64> = slots.iter().filter_map(|s| s.as_ref()).map(|p| p.onset_error_ms.abs()).collect();
        // A speed-ratio sample belongs to the measure of its LATER target.
        let ratios_m: Vec<f64> = slots.iter()
            .filter_map(|s| s.as_ref())
            .filter_map(|p| target_ordinals.get(p.score_event_id.as_str()).copied())
            .filter_map(|ordinal| ratio_by_ordinal.get(&ordinal).copied())
            .collect();
        measures.push(MeasureReport {
            measure: *measure_value,
            matched: matched_count,
            missed: missed_count,
            mean_abs_onset_error_ms: if errors.is_empty() { None } else { Some(errors.iter().sum::<f64>() / errors.len() as f64) },
            mean_speed_ratio: if ratios_m.is_empty() { None } else { Some(ratios_m.iter().sum::<f64>() / ratios_m.len() as f64) },
        });
    }
    measures.sort_by_key(|m| m.measure);

    // ---- pitch accuracy ----
    let wrong_pitch = pairs.iter().filter(|p| !p.pitch_matched).count();
    let pitch = PitchAccuracy {
        targets: score_events.len(),
        correct: pairs.iter().filter(|p| p.pitch_matched).count(),
        wrong_pitch,
        missed: alignment.missed_score_event_ids.len(),
        extra: alignment.extra_performed_ids.len(),
        recall: if score_events.is_empty() { None } else { Some(pairs.iter().filter(|p| p.pitch_matched).count() as f64 / score_events.len() as f64) },
        precision: {
            let played = pairs.len() + alignment.extra_performed_ids.len();
            if played == 0 { None } else { Some(pairs.iter().filter(|p| p.pitch_matched).count() as f64 / played as f64) }
        },
    };

    // ---- sub-scores (None = unscored; renormalized downstream) ----
    let pitch_score = if score_events.is_empty() { None } else { Some(100.0 * pitch.recall.unwrap()) };
    let onset_score = onset.out_of_tolerance_ratio.map(|r| 100.0 * (1.0 - r));
    let rhythm_score = rhythm.jitter_ratio_mad.map(|mad_value| {
        let raw = 100.0 * (1.0 - (mad_value / (config.jitter_ratio_mad * 3.0)).min(1.0));
        if compensation { raw * 0.6 } else { raw }
    }).filter(|_| rhythm.interval_samples >= 2);
    let duration_score = if duration.graded > 0 {
        Some(100.0 * (duration.graded - too_short - too_long) as f64 / duration.graded as f64)
    } else { None };
    let continuity_score = continuity.covered_ratio.map(|c| 100.0 * c);

    let overall = compute_overall(vec![
        SubScore { name: "pitch", score: pitch_score, weight: config.weights.pitch, sample_count: score_events.len() },
        SubScore { name: "onset", score: onset_score, weight: config.weights.onset, sample_count: matched },
        SubScore { name: "rhythm", score: rhythm_score, weight: config.weights.rhythm, sample_count: rhythm.interval_samples },
        SubScore { name: "duration", score: duration_score, weight: config.weights.duration, sample_count: duration.graded },
        SubScore { name: "continuity", score: continuity_score, weight: config.weights.continuity, sample_count: score_events.len() },
    ]);

    // ---- confidence ----
    let mut data_degraded = false;
    let confidence = if matched < config.min_rhythm_samples {
        Confidence::Low
    } else if rhythm.interval_samples < 2 || onset.mean_absolute_ms.is_none() {
        Confidence::Low
    } else {
        Confidence::High
    };

    // ---- diagnostics (every one carries evidence + ids) ----
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let pair_ids: Vec<String> = pairs.iter().map(|p| p.performed_note_id.clone()).collect();
    let score_ids: Vec<String> = pairs.iter().map(|p| p.score_event_id.clone()).collect();

    if let (Some(offset), Some(jit)) = (onset.signed_median_ms, rhythm.jitter_ratio_mad) {
        if matched >= config.min_rhythm_samples {
            if offset.abs() >= config.global_offset_ms && jit < config.jitter_ratio_mad {
                diagnostics.push(Diagnostic {
                    category: "global-offset",
                    severity: if offset.abs() >= config.global_offset_ms * 2.0 { "high" } else { "moderate" },
                    measure_range: None,
                    evidence: format!("median signed onset error {offset:.1} ms over {matched} matched pairs; jitter MAD {jit:.3} < {}", config.jitter_ratio_mad),
                    confidence: Confidence::High,
                    suggested_action: "检查输入链路固定延迟与起拍对齐；这不是忽快忽慢".to_string(),
                    score_event_ids: score_ids.clone(),
                    performed_event_ids: pair_ids.clone(),
                });
            } else if jit >= config.jitter_ratio_mad {
                let severity = if jit >= config.jitter_ratio_mad * 2.0 { "high" } else { "moderate" };
                let (category, action) = if compensation {
                    ("rhythm-compensation", "整体结束时间接近目标但内部忽快忽慢：改用分段节拍器练习，不要以总时长为准")
                } else {
                    ("local-jitter", "局部忽快忽慢：降低速度并开启节拍器，先求每个间隔稳定")
                };
                diagnostics.push(Diagnostic {
                    category,
                    severity,
                    measure_range: None,
                    evidence: format!("IOI speed-ratio MAD {jit:.3} >= {} over {} intervals", config.jitter_ratio_mad, rhythm.interval_samples),
                    confidence,
                    suggested_action: action.to_string(),
                    score_event_ids: score_ids.clone(),
                    performed_event_ids: pair_ids.clone(),
                });
            }
        }
    }
    if let Some(slope_value) = rhythm.drift_ratio_slope_per_index {
        if slope_value.abs() >= config.drift_ratio_slope {
            let direction = if slope_value > 0.0 { "渐慢（速度比持续上升）" } else { "渐快（速度比持续下降）" };
            diagnostics.push(Diagnostic {
                category: "tempo-drift",
                severity: "moderate",
                measure_range: None,
                evidence: format!("speed-ratio slope {slope_value:.4} per target over {} intervals", rhythm.interval_samples),
                confidence,
                suggested_action: format!("{direction}；用分段循环巩固节奏网格"),
                score_event_ids: score_ids.clone(),
                performed_event_ids: pair_ids.clone(),
            });
        }
    }
    if pitch.missed > 0 {
        diagnostics.push(Diagnostic {
            category: "missed-notes",
            severity: if pitch.missed as f64 / score_events.len() as f64 > 0.2 { "high" } else { "moderate" },
            measure_range: None,
            evidence: format!("{} of {} targets unmatched", pitch.missed, score_events.len()),
            confidence: Confidence::High,
            suggested_action: "先以慢速补齐漏弹音符，再回到目标速度".to_string(),
            score_event_ids: alignment.missed_score_event_ids.clone(),
            performed_event_ids: Vec::new(),
        });
    }
    if pitch.extra > 0 {
        diagnostics.push(Diagnostic {
            category: "extra-notes",
            severity: "moderate",
            measure_range: None,
            evidence: format!("{} performed notes unmatched to the score", pitch.extra),
            confidence: Confidence::High,
            suggested_action: "检查多弹的音；休止段中的意外起音已单独列出".to_string(),
            score_event_ids: Vec::new(),
            performed_event_ids: alignment.extra_performed_ids.clone(),
        });
    }
    if wrong_pitch > 0 {
        diagnostics.push(Diagnostic {
            category: "pitch-errors",
            severity: "moderate",
            measure_range: None,
            evidence: format!("{wrong_pitch} matched pairs with wrong pitch"),
            confidence: Confidence::High,
            suggested_action: "单独练习错音位置（见事件关联）".to_string(),
            score_event_ids: pairs.iter().filter(|p| !p.pitch_matched).map(|p| p.score_event_id.clone()).collect(),
            performed_event_ids: pairs.iter().filter(|p| !p.pitch_matched).map(|p| p.performed_note_id.clone()).collect(),
        });
    }
    if duration.graded > 0 && too_short > 0 && too_short as f64 / duration.graded as f64 >= 0.3 {
        diagnostics.push(Diagnostic {
            category: "duration",
            severity: "moderate",
            measure_range: None,
            evidence: format!("{too_short}/{graded} graded releases shorter than nominal (mean ratio {mean:.2})", graded = duration.graded, mean = duration.mean_ratio.unwrap_or(0.0)),
            confidence: Confidence::Medium,
            suggested_action: "切换到按键时长模式，练习把时值按满".to_string(),
            score_event_ids: Vec::new(),
            performed_event_ids: Vec::new(),
        });
    }
    if !alignment.rest_window_extra_ids.is_empty() {
        diagnostics.push(Diagnostic {
            category: "rest-violation",
            severity: "moderate",
            measure_range: None,
            evidence: format!("{} extra onsets inside structural gaps (rest windows)", alignment.rest_window_extra_ids.len()),
            confidence: Confidence::Medium,
            suggested_action: "休止期间数拍；把休止当作节奏的一部分".to_string(),
            score_event_ids: Vec::new(),
            performed_event_ids: alignment.rest_window_extra_ids.clone(),
        });
    }
    if confidence == Confidence::Low {
        diagnostics.push(Diagnostic {
            category: "low-confidence",
            severity: "info",
            measure_range: None,
            evidence: format!("only {matched} matched pairs (< {}); rhythm conclusions suppressed", config.min_rhythm_samples),
            confidence: Confidence::NotAssessable,
            suggested_action: "数据不足：多弹几轮再下结论".to_string(),
            score_event_ids: Vec::new(),
            performed_event_ids: Vec::new(),
        });
    }

    // ---- practice ranges: worst 1–3 measures by misses + jitter ----
    let mut practice_ranges: Vec<PracticeRange> = Vec::new();
    let mut ranked: Vec<&MeasureReport> = measures.iter()
        .filter(|m| m.missed > 0 || m.mean_abs_onset_error_ms.map(|e| e > config.onset_tolerance_ms).unwrap_or(false))
        .collect();
    ranked.sort_by(|a, b| {
        let key = |m: &MeasureReport| m.missed as f64 * 2.0 + m.mean_abs_onset_error_ms.unwrap_or(0.0) / 100.0;
        key(b).total_cmp(&key(a))
    });
    for (priority, m) in ranked.iter().take(3).enumerate() {
        practice_ranges.push(PracticeRange {
            start_measure: m.measure,
            end_measure: m.measure,
            reason: format!("missed {} · mean |onset err| {}",
                m.missed,
                m.mean_abs_onset_error_ms.map(|v| format!("{v:.0}ms")).unwrap_or_else(|| "n/a".into())),
            priority: (priority + 1) as u8,
        });
    }

    Ok(SessionScoreReport {
        algorithm_version: SCORING_ALGORITHM_VERSION.to_string(),
        alignment,
        pitch,
        onset,
        rhythm,
        duration,
        continuity,
        measures,
        overall,
        confidence,
        data_degraded,
        diagnostics,
        practice_ranges,
    })
}

impl ScoreEvent {
}

// ---------------------------------------------------------------------------
// Phase 3: practice profile / progressive tempo gate (spec §7, acceptance N).

/// Explicit semantics: only N consecutive passes raise the tempo by stepBpm
/// (capped at maxTempoBpm); a failed attempt resets the streak and K
/// consecutive failures drop the tempo by fallbackBpm (floored at 40 BPM).
/// "维持 on single failure" avoids punishing one shaky bar with a big drop.
#[derive(Debug, Clone, PartialEq)]
pub struct PracticeProfileV1 {
    pub current_bpm: u16,
    pub step_bpm: u16,
    pub required_consecutive_passes: u32,
    pub max_tempo_bpm: u16,
    pub fallback_bpm: u16,
    pub consecutive_passes: u32,
    pub consecutive_failures: u32,
    pub failures_before_fallback: u32,
}

impl PracticeProfileV1 {
    pub fn new(current_bpm: u16, step_bpm: u16, required_consecutive_passes: u32,
               max_tempo_bpm: u16, fallback_bpm: u16) -> Self {
        Self {
            current_bpm, step_bpm, required_consecutive_passes, max_tempo_bpm,
            fallback_bpm, consecutive_passes: 0, consecutive_failures: 0,
            failures_before_fallback: 2,
        }
    }

    /// Records one graded attempt; returns the resulting tempo.
    pub fn record_pass(&mut self, passed: bool) -> u16 {
        if passed {
            self.consecutive_failures = 0;
            self.consecutive_passes += 1;
            if self.consecutive_passes >= self.required_consecutive_passes
                && self.current_bpm < self.max_tempo_bpm {
                self.current_bpm = (self.current_bpm + self.step_bpm).min(self.max_tempo_bpm);
                self.consecutive_passes = 0;
            }
        } else {
            self.consecutive_passes = 0;
            self.consecutive_failures += 1;
            if self.consecutive_failures >= self.failures_before_fallback {
                self.current_bpm = self.current_bpm.saturating_sub(self.fallback_bpm).max(40);
                self.consecutive_failures = 0;
            }
        }
        self.current_bpm
    }
}
