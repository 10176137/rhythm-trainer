//! Deterministic, explainable teaching support built on top of timing judgments.
//!
//! This module does NOT claim to infer a learner's mental state. It detects
//! observable timing patterns, emits evidence-bearing hypotheses, and suggests
//! simple exercises. Pitch/voice/articulation diagnoses require score-to-MIDI
//! alignment and are intentionally outside this first implementation.

use crate::{Grade, Judgment};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimingIssue {
    MeasurementUntrusted,
    InsufficientEvidence,
    GlobalLateBias,
    GlobalEarlyBias,
    UnstableTiming,
    TempoDrift,
    FrequentMisses,
    FrequentExtras,
    RestReentryTiming,
    OffbeatTiming,
}

impl TimingIssue {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MeasurementUntrusted => "measurement_untrusted",
            Self::InsufficientEvidence => "insufficient_evidence",
            Self::GlobalLateBias => "global_late_bias",
            Self::GlobalEarlyBias => "global_early_bias",
            Self::UnstableTiming => "unstable_timing",
            Self::TempoDrift => "tempo_drift",
            Self::FrequentMisses => "frequent_misses",
            Self::FrequentExtras => "frequent_extras",
            Self::RestReentryTiming => "rest_reentry_timing",
            Self::OffbeatTiming => "offbeat_timing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Info,
    Moderate,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceConfidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TimingFeatures {
    /// Count of expected targets represented in the judgment stream.
    pub target_count: usize,
    pub matched_count: usize,
    pub miss_count: usize,
    pub extra_count: usize,
    pub miss_rate: f64,
    /// Extra events divided by target_count; useful as a rough signal only.
    pub extra_rate: f64,
    /// Signed error: positive means late; calculated from matched targets only.
    pub mean_signed_error_ms: Option<f64>,
    pub median_signed_error_ms: Option<f64>,
    pub mean_absolute_error_ms: Option<f64>,
    pub standard_deviation_ms: Option<f64>,
    /// Least-squares signed-error slope in ms per target index. Positive means
    /// later targets tend to become more late (or less early).
    pub drift_ms_per_target: Option<f64>,
    pub rest_reentry_count: usize,
    pub rest_reentry_mean_signed_ms: Option<f64>,
    pub non_reentry_mean_signed_ms: Option<f64>,
    pub offbeat_count: usize,
    pub offbeat_mean_absolute_ms: Option<f64>,
    pub non_offbeat_mean_absolute_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Diagnostic {
    pub issue: TimingIssue,
    pub severity: Severity,
    /// This reflects available data and rule support, not certainty about cause.
    pub confidence: EvidenceConfidence,
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DiagnosisReport {
    pub trustworthy: bool,
    pub features: TimingFeatures,
    /// Ordered most-actionable first and capped to avoid overwhelming the learner.
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DiagnosisThresholds {
    pub minimum_targets: usize,
    pub minimum_matched_hits: usize,
    pub global_bias_ms: f64,
    pub unstable_standard_deviation_ms: f64,
    pub miss_rate: f64,
    pub extra_rate: f64,
    pub drift_ms_per_target: f64,
    pub grouped_error_difference_ms: f64,
    pub minimum_group_hits: usize,
    pub maximum_diagnostics: usize,
}

impl Default for DiagnosisThresholds {
    fn default() -> Self {
        Self {
            minimum_targets: 8,
            minimum_matched_hits: 6,
            global_bias_ms: 20.0,
            unstable_standard_deviation_ms: 30.0,
            miss_rate: 0.15,
            extra_rate: 0.10,
            drift_ms_per_target: 3.0,
            grouped_error_difference_ms: 20.0,
            minimum_group_hits: 2,
            maximum_diagnostics: 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DiagnosticContext {
    /// False when clock, event integrity, or score alignment is not trustworthy.
    pub measurement_trustworthy: bool,
    /// Target IDs whose onset follows a meaningful rest. Populate from parsed score.
    pub rest_reentry_target_ids: Vec<String>,
    /// Target IDs marked as offbeat/subdivision positions by the score model.
    pub offbeat_target_ids: Vec<String>,
    pub thresholds: DiagnosisThresholds,
}

impl DiagnosticContext {
    pub fn new(measurement_trustworthy: bool) -> Self {
        Self {
            measurement_trustworthy,
            rest_reentry_target_ids: Vec::new(),
            offbeat_target_ids: Vec::new(),
            thresholds: DiagnosisThresholds::default(),
        }
    }
}

/// Extracts deterministic features from an already finalized judgment stream.
pub fn extract_timing_features(
    judgments: &[Judgment],
    context: &DiagnosticContext,
) -> TimingFeatures {
    let target_count = judgments.iter().filter(|j| j.target_id.is_some()).count();
    let miss_count = judgments.iter().filter(|j| j.grade == Grade::Miss).count();
    let extra_count = judgments.iter().filter(|j| j.grade == Grade::Extra).count();

    let matched: Vec<&Judgment> = judgments
        .iter()
        .filter(|j| matches!(j.grade, Grade::Perfect | Grade::Good) && j.error_ms.is_some())
        .collect();
    let errors: Vec<f64> = matched.iter().filter_map(|j| j.error_ms).collect();
    let mean_signed_error_ms = mean(&errors);
    let median_signed_error_ms = median(errors.clone());
    let mean_absolute_error_ms = mean(&errors.iter().map(|v| v.abs()).collect::<Vec<_>>());
    let standard_deviation_ms = population_stddev(&errors, mean_signed_error_ms);
    let drift_ms_per_target = regression_slope(&matched);

    let rest_ids = &context.rest_reentry_target_ids;
    let rest_errors: Vec<f64> = matched
        .iter()
        .filter(|j| j.target_id.as_ref().is_some_and(|id| rest_ids.contains(id)))
        .filter_map(|j| j.error_ms)
        .collect();
    let non_rest_errors: Vec<f64> = matched
        .iter()
        .filter(|j| j.target_id.as_ref().is_some_and(|id| !rest_ids.contains(id)))
        .filter_map(|j| j.error_ms)
        .collect();

    let offbeat_ids = &context.offbeat_target_ids;
    let offbeat_errors: Vec<f64> = matched
        .iter()
        .filter(|j| j.target_id.as_ref().is_some_and(|id| offbeat_ids.contains(id)))
        .filter_map(|j| j.error_ms.map(f64::abs))
        .collect();
    let non_offbeat_errors: Vec<f64> = matched
        .iter()
        .filter(|j| j.target_id.as_ref().is_some_and(|id| !offbeat_ids.contains(id)))
        .filter_map(|j| j.error_ms.map(f64::abs))
        .collect();

    TimingFeatures {
        target_count,
        matched_count: matched.len(),
        miss_count,
        extra_count,
        miss_rate: rate(miss_count, target_count),
        extra_rate: rate(extra_count, target_count),
        mean_signed_error_ms,
        median_signed_error_ms,
        mean_absolute_error_ms,
        standard_deviation_ms,
        drift_ms_per_target,
        rest_reentry_count: rest_errors.len(),
        rest_reentry_mean_signed_ms: mean(&rest_errors),
        non_reentry_mean_signed_ms: mean(&non_rest_errors),
        offbeat_count: offbeat_errors.len(),
        offbeat_mean_absolute_ms: mean(&offbeat_errors),
        non_offbeat_mean_absolute_ms: mean(&non_offbeat_errors),
    }
}

/// Produces a small set of explainable timing diagnoses.
///
/// Important: these are correlations/hypotheses from MIDI timing, not definitive
/// explanations of why a learner made an error. Do not run performance diagnoses
/// when the measurement or score alignment has failed its quality gate.
pub fn diagnose_timing(
    judgments: &[Judgment],
    context: &DiagnosticContext,
) -> DiagnosisReport {
    let features = extract_timing_features(judgments, context);
    if !context.measurement_trustworthy {
        return DiagnosisReport {
            trustworthy: false,
            features,
            diagnostics: vec![Diagnostic {
                issue: TimingIssue::MeasurementUntrusted,
                severity: Severity::High,
                confidence: EvidenceConfidence::High,
                evidence: "Input timing, event completeness, or score alignment failed the quality gate; performance diagnosis is suppressed.".to_string(),
            }],
        };
    }

    let t = &context.thresholds;
    let mut diagnostics = Vec::new();
    let enough_targets = features.target_count >= t.minimum_targets;
    let enough_matches = features.matched_count >= t.minimum_matched_hits;
    let confidence = confidence_for(features.matched_count, t.minimum_matched_hits);

    if !enough_targets {
        diagnostics.push(Diagnostic {
            issue: TimingIssue::InsufficientEvidence,
            severity: Severity::Info,
            confidence: EvidenceConfidence::Low,
            evidence: format!("Only {} targets were observed; at least {} are recommended for this analysis.", features.target_count, t.minimum_targets),
        });
        return make_report(features, diagnostics, t.maximum_diagnostics);
    }

    if features.miss_rate >= t.miss_rate {
        diagnostics.push(Diagnostic {
            issue: TimingIssue::FrequentMisses,
            severity: if features.miss_rate >= (t.miss_rate * 2.0).min(1.0) { Severity::High } else { Severity::Moderate },
            confidence: confidence_for(features.target_count, t.minimum_targets),
            evidence: format!("{} of {} target onsets were missed ({:.0}%; configured trigger {:.0}%).", features.miss_count, features.target_count, features.miss_rate * 100.0, t.miss_rate * 100.0),
        });
    }
    if features.extra_rate >= t.extra_rate {
        diagnostics.push(Diagnostic {
            issue: TimingIssue::FrequentExtras,
            severity: if features.extra_rate >= (t.extra_rate * 2.0) { Severity::High } else { Severity::Moderate },
            confidence: confidence_for(features.target_count, t.minimum_targets),
            evidence: format!("{} extra events for {} targets (ratio {:.0}%; configured trigger {:.0}%). Check both playing control and MIDI duplicate-event handling.", features.extra_count, features.target_count, features.extra_rate * 100.0, t.extra_rate * 100.0),
        });
    }

    if enough_matches {
        if let Some(mean_ms) = features.mean_signed_error_ms {
            if mean_ms >= t.global_bias_ms {
                diagnostics.push(Diagnostic {
                    issue: TimingIssue::GlobalLateBias,
                    severity: if mean_ms >= t.global_bias_ms * 2.0 { Severity::High } else { Severity::Moderate },
                    confidence,
                    evidence: format!("Matched hits average {:.1} ms late; rule threshold is {:.1} ms. This is a performance observation, not a device-calibration offset.", mean_ms, t.global_bias_ms),
                });
            } else if mean_ms <= -t.global_bias_ms {
                diagnostics.push(Diagnostic {
                    issue: TimingIssue::GlobalEarlyBias,
                    severity: if mean_ms <= -t.global_bias_ms * 2.0 { Severity::High } else { Severity::Moderate },
                    confidence,
                    evidence: format!("Matched hits average {:.1} ms early; rule threshold is {:.1} ms.", mean_ms, t.global_bias_ms),
                });
            }
        }
        if let Some(sd) = features.standard_deviation_ms {
            if sd >= t.unstable_standard_deviation_ms {
                diagnostics.push(Diagnostic {
                    issue: TimingIssue::UnstableTiming,
                    severity: if sd >= t.unstable_standard_deviation_ms * 1.5 { Severity::High } else { Severity::Moderate },
                    confidence,
                    evidence: format!("Population standard deviation is {:.1} ms; rule threshold is {:.1} ms.", sd, t.unstable_standard_deviation_ms),
                });
            }
        }
        if let Some(slope) = features.drift_ms_per_target {
            if slope.abs() >= t.drift_ms_per_target {
                diagnostics.push(Diagnostic {
                    issue: TimingIssue::TempoDrift,
                    severity: if slope.abs() >= t.drift_ms_per_target * 2.0 { Severity::High } else { Severity::Moderate },
                    confidence,
                    evidence: format!("Signed timing error changes by approximately {:.1} ms per target index; rule threshold is {:.1} ms/target. Verify with a longer passage before making a strong claim.", slope, t.drift_ms_per_target),
                });
            }
        }
        diagnose_grouped_timing(&features, context, &mut diagnostics);
    } else {
        diagnostics.push(Diagnostic {
            issue: TimingIssue::InsufficientEvidence,
            severity: Severity::Info,
            confidence: EvidenceConfidence::Low,
            evidence: format!("Only {} hits were matched; at least {} matched hits are recommended for timing-pattern diagnosis.", features.matched_count, t.minimum_matched_hits),
        });
    }

    make_report(features, diagnostics, t.maximum_diagnostics)
}

fn diagnose_grouped_timing(
    features: &TimingFeatures,
    context: &DiagnosticContext,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let t = &context.thresholds;
    if features.rest_reentry_count >= t.minimum_group_hits {
        if let (Some(rest), Some(other)) = (features.rest_reentry_mean_signed_ms, features.non_reentry_mean_signed_ms) {
            let difference = rest - other;
            if difference.abs() >= t.grouped_error_difference_ms {
                diagnostics.push(Diagnostic {
                    issue: TimingIssue::RestReentryTiming,
                    severity: if difference.abs() >= t.grouped_error_difference_ms * 1.5 { Severity::High } else { Severity::Moderate },
                    confidence: confidence_for(features.rest_reentry_count, t.minimum_group_hits),
                    evidence: format!("Targets following rests average {:.1} ms signed error versus {:.1} ms for other targets (difference {:.1} ms). This pattern needs repeated-session confirmation.", rest, other, difference),
                });
            }
        }
    }
    if features.offbeat_count >= t.minimum_group_hits {
        if let (Some(offbeat), Some(other)) = (features.offbeat_mean_absolute_ms, features.non_offbeat_mean_absolute_ms) {
            let difference = offbeat - other;
            if difference >= t.grouped_error_difference_ms {
                diagnostics.push(Diagnostic {
                    issue: TimingIssue::OffbeatTiming,
                    severity: if difference >= t.grouped_error_difference_ms * 1.5 { Severity::High } else { Severity::Moderate },
                    confidence: confidence_for(features.offbeat_count, t.minimum_group_hits),
                    evidence: format!("Offbeat targets have {:.1} ms mean absolute error versus {:.1} ms for other targets (difference {:.1} ms).", offbeat, other, difference),
                });
            }
        }
    }
}

fn make_report(features: TimingFeatures, mut diagnostics: Vec<Diagnostic>, maximum: usize) -> DiagnosisReport {
    // Severity first; stable sort preserves deterministic rule order within a severity.
    diagnostics.sort_by(|a, b| b.severity.cmp(&a.severity));
    diagnostics.truncate(maximum);
    DiagnosisReport { trustworthy: true, features, diagnostics }
}

fn confidence_for(sample_count: usize, minimum: usize) -> EvidenceConfidence {
    if sample_count >= minimum.saturating_mul(4) {
        EvidenceConfidence::High
    } else if sample_count >= minimum.saturating_mul(2) {
        EvidenceConfidence::Medium
    } else {
        EvidenceConfidence::Low
    }
}

fn rate(count: usize, denominator: usize) -> f64 {
    if denominator == 0 { 0.0 } else { count as f64 / denominator as f64 }
}

fn mean(values: &[f64]) -> Option<f64> {
    if values.is_empty() { None } else { Some(values.iter().sum::<f64>() / values.len() as f64) }
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() { return None; }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        Some((values[middle - 1] + values[middle]) / 2.0)
    } else {
        Some(values[middle])
    }
}

fn population_stddev(values: &[f64], mean_value: Option<f64>) -> Option<f64> {
    let mean_value = mean_value?;
    if values.is_empty() { return None; }
    let variance = values.iter().map(|v| (v - mean_value).powi(2)).sum::<f64>() / values.len() as f64;
    Some(variance.sqrt())
}

fn regression_slope(judgments: &[&Judgment]) -> Option<f64> {
    if judgments.len() < 3 { return None; }
    let points: Vec<(f64, f64)> = judgments.iter().enumerate().filter_map(|(position, judgment)| {
        judgment.error_ms.map(|y| (judgment.target_index.map(|i| i as f64).unwrap_or(position as f64), y))
    }).collect();
    if points.len() < 3 { return None; }
    let n = points.len() as f64;
    let mean_x = points.iter().map(|p| p.0).sum::<f64>() / n;
    let mean_y = points.iter().map(|p| p.1).sum::<f64>() / n;
    let numerator = points.iter().map(|(x, y)| (x - mean_x) * (y - mean_y)).sum::<f64>();
    let denominator = points.iter().map(|(x, _)| (x - mean_x).powi(2)).sum::<f64>();
    if denominator <= f64::EPSILON { None } else { Some(numerator / denominator) }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExerciseKind {
    VerifyInputMeasurement,
    CollectMoreEvidence,
    SlowLoopWithMetronome,
    CountSubdivision,
    RestReentryDrill,
    OffbeatSubdivisionDrill,
    ControlledAttackDrill,
    ReviewEventAlignment,
}

impl ExerciseKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::VerifyInputMeasurement => "verify_input_measurement",
            Self::CollectMoreEvidence => "collect_more_evidence",
            Self::SlowLoopWithMetronome => "slow_loop_with_metronome",
            Self::CountSubdivision => "count_subdivision",
            Self::RestReentryDrill => "rest_reentry_drill",
            Self::OffbeatSubdivisionDrill => "offbeat_subdivision_drill",
            Self::ControlledAttackDrill => "controlled_attack_drill",
            Self::ReviewEventAlignment => "review_event_alignment",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetronomeMode {
    EveryBeat,
    BeatOneOnly,
    Silent,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExercisePrescription {
    pub target_issue: TimingIssue,
    pub exercise: ExerciseKind,
    pub suggested_bpm: Option<u16>,
    pub metronome_mode: MetronomeMode,
    pub loops_per_set: u8,
    pub required_consecutive_passes: u8,
    pub maximum_mean_absolute_error_ms: f64,
    pub require_unassisted_transfer_test: bool,
    pub rationale: String,
}

/// Maps one evidence-backed diagnosis to one small, executable next step.
/// Only a single primary prescription is returned to avoid overwhelming the user.
pub fn recommend_exercise(
    report: &DiagnosisReport,
    current_bpm: Option<u16>,
) -> Option<ExercisePrescription> {
    let primary = report.diagnostics.first()?;
    let (exercise, metronome_mode, reduce_tempo, rationale) = match primary.issue {
        TimingIssue::MeasurementUntrusted => (
            ExerciseKind::VerifyInputMeasurement,
            MetronomeMode::EveryBeat,
            false,
            "Do not train against an untrustworthy score. Validate event timestamps, event completeness and score alignment first.",
        ),
        TimingIssue::InsufficientEvidence => (
            ExerciseKind::CollectMoreEvidence,
            MetronomeMode::EveryBeat,
            false,
            "Collect a longer clean attempt before drawing a timing-pattern conclusion.",
        ),
        TimingIssue::RestReentryTiming => (
            ExerciseKind::RestReentryDrill,
            MetronomeMode::EveryBeat,
            true,
            "Loop the phrase around the rest, explicitly count the subdivision through the silence, then repeat without spoken counting.",
        ),
        TimingIssue::OffbeatTiming => (
            ExerciseKind::OffbeatSubdivisionDrill,
            MetronomeMode::EveryBeat,
            true,
            "Isolate the offbeat positions and count subdivisions aloud before returning to the complete phrase.",
        ),
        TimingIssue::UnstableTiming | TimingIssue::TempoDrift | TimingIssue::FrequentMisses => (
            ExerciseKind::SlowLoopWithMetronome,
            MetronomeMode::EveryBeat,
            true,
            "Loop a short segment at a lower tempo. Increase tempo only after repeatable passes.",
        ),
        TimingIssue::GlobalLateBias | TimingIssue::GlobalEarlyBias => (
            ExerciseKind::CountSubdivision,
            MetronomeMode::EveryBeat,
            false,
            "Practice placing notes against a stable pulse and count subdivisions. Keep the measured signed bias visible; do not calibrate it away.",
        ),
        TimingIssue::FrequentExtras => (
            ExerciseKind::ControlledAttackDrill,
            MetronomeMode::EveryBeat,
            false,
            "Review extra events and confirm MIDI duplicate/note aggregation is correct before treating every event as a playing mistake.",
        ),
    };

    let suggested_bpm = current_bpm.map(|bpm| {
        if reduce_tempo { ((bpm as f64 * 0.85).round() as u16).max(20) } else { bpm }
    });
    Some(ExercisePrescription {
        target_issue: primary.issue,
        exercise,
        suggested_bpm,
        metronome_mode,
        loops_per_set: 4,
        required_consecutive_passes: 3,
        maximum_mean_absolute_error_ms: 30.0,
        require_unassisted_transfer_test: true,
        rationale: rationale.to_string(),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MasteryState {
    NotAssessed,
    Developing,
    Provisional,
    Consolidated,
    NeedsReview,
}

impl MasteryState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAssessed => "not_assessed",
            Self::Developing => "developing",
            Self::Provisional => "provisional",
            Self::Consolidated => "consolidated",
            Self::NeedsReview => "needs_review",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MasteryPolicy {
    pub minimum_targets_per_attempt: usize,
    pub required_consecutive_passes: u32,
    pub required_transfer_passes: u32,
    pub required_delayed_passes: u32,
}

impl Default for MasteryPolicy {
    fn default() -> Self {
        Self {
            minimum_targets_per_attempt: 8,
            required_consecutive_passes: 3,
            required_transfer_passes: 2,
            required_delayed_passes: 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MasteryAttempt {
    /// Caller computes this from quality-checked score metrics and a versioned policy.
    pub passed: bool,
    pub trustworthy: bool,
    pub target_count: usize,
    pub assisted: bool,
    pub transfer_test: bool,
    pub delayed_retest: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkillProgress {
    pub skill_id: String,
    pub state: MasteryState,
    pub trustworthy_attempts: u32,
    pub consecutive_passes: u32,
    pub transfer_passes: u32,
    pub delayed_passes: u32,
    pub last_attempt_passed: Option<bool>,
}

impl SkillProgress {
    fn new(skill_id: String) -> Self {
        Self {
            skill_id,
            state: MasteryState::NotAssessed,
            trustworthy_attempts: 0,
            consecutive_passes: 0,
            transfer_passes: 0,
            delayed_passes: 0,
            last_attempt_passed: None,
        }
    }
}

/// Small rule-based student model. It stores evidence counts; it does not claim
/// that a simple pass rate is a scientifically calibrated mastery probability.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StudentModel {
    skills: std::collections::BTreeMap<String, SkillProgress>,
}

impl StudentModel {
    pub fn get(&self, skill_id: &str) -> Option<&SkillProgress> {
        self.skills.get(skill_id)
    }

    pub fn observe_attempt(
        &mut self,
        skill_id: impl Into<String>,
        attempt: MasteryAttempt,
        policy: &MasteryPolicy,
    ) -> MasteryState {
        let skill_id = skill_id.into();

        // Bad measurements or tiny attempts must not count as evidence for or
        // against mastery, and must not even create a skill entry: a snapshot
        // should only contain skills with at least one usable observation.
        if !attempt.trustworthy || attempt.target_count < policy.minimum_targets_per_attempt {
            return self
                .skills
                .get(&skill_id)
                .map(|progress| progress.state)
                .unwrap_or(MasteryState::NotAssessed);
        }

        let progress = self.skills.entry(skill_id.clone()).or_insert_with(|| SkillProgress::new(skill_id));

        let old_state = progress.state;
        progress.trustworthy_attempts += 1;
        progress.last_attempt_passed = Some(attempt.passed);
        if attempt.passed {
            progress.consecutive_passes += 1;
        } else {
            progress.consecutive_passes = 0;
        }

        if attempt.transfer_test && !attempt.assisted {
            if attempt.passed {
                progress.transfer_passes += 1;
            } else {
                progress.transfer_passes = 0;
            }
        }
        if attempt.delayed_retest && !attempt.assisted {
            if attempt.passed {
                progress.delayed_passes += 1;
            } else {
                progress.delayed_passes = 0;
            }
        }

        progress.state = if old_state == MasteryState::Consolidated && !attempt.passed {
            MasteryState::NeedsReview
        } else if progress.transfer_passes >= policy.required_transfer_passes
            && progress.delayed_passes >= policy.required_delayed_passes
        {
            MasteryState::Consolidated
        } else if progress.consecutive_passes >= policy.required_consecutive_passes {
            MasteryState::Provisional
        } else {
            MasteryState::Developing
        };
        progress.state
    }

    /// Plain-data snapshot for persistence outside the core. Order is
    /// deterministic (sorted by skill id) so identical models produce
    /// identical snapshots.
    pub fn snapshot(&self) -> Vec<SkillProgress> {
        self.skills.values().cloned().collect()
    }

    /// Rebuilds a model from a persisted snapshot. Duplicated or empty skill
    /// ids are rejected instead of being silently merged away.
    pub fn restore(snapshot: Vec<SkillProgress>) -> Result<Self, crate::CoreError> {
        let mut skills = std::collections::BTreeMap::new();
        for progress in snapshot {
            if progress.skill_id.trim().is_empty() {
                return Err(crate::CoreError::InvalidSnapshot(
                    "skill_id cannot be empty".to_string(),
                ));
            }
            let skill_id = progress.skill_id.clone();
            if skills.insert(skill_id.clone(), progress).is_some() {
                return Err(crate::CoreError::InvalidSnapshot(format!(
                    "duplicate skill_id `{skill_id}`; refusing to silently drop data"
                )));
            }
        }
        Ok(Self { skills })
    }

    pub fn skill_count(&self) -> usize {
        self.skills.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn judgment(index: usize, error: Option<f64>, grade: Grade) -> Judgment {
        let target_id = if grade == Grade::Extra { None } else { Some(format!("t{index}")) };
        Judgment {
            grade,
            target_id,
            target_index: if grade == Grade::Extra { None } else { Some(index) },
            strike_seq: Some(index as u64 + 1),
            error_ms: error,
            expected_at_ms: Some(index as f64 * 500.0),
            actual_at_ms: error.map(|e| index as f64 * 500.0 + e),
            bar: Some((index / 4 + 1) as u32),
            beat: Some((index % 4 + 1) as f64),
        }
    }

    fn stable_late_judgments(count: usize) -> Vec<Judgment> {
        (0..count).map(|i| judgment(i, Some(35.0), Grade::Good)).collect()
    }

    #[test]
    fn flags_global_late_bias_without_calling_it_device_calibration() {
        let judgments = stable_late_judgments(12);
        let report = diagnose_timing(&judgments, &DiagnosticContext::new(true));
        assert!(report.diagnostics.iter().any(|d| d.issue == TimingIssue::GlobalLateBias));
        assert!(report.diagnostics.iter().all(|d| !d.evidence.contains("calibrate it away")));
    }

    #[test]
    fn suppresses_performance_diagnosis_when_measurement_is_untrusted() {
        let judgments = stable_late_judgments(12);
        let report = diagnose_timing(&judgments, &DiagnosticContext::new(false));
        assert!(!report.trustworthy);
        assert_eq!(report.diagnostics.len(), 1);
        assert_eq!(report.diagnostics[0].issue, TimingIssue::MeasurementUntrusted);
    }

    #[test]
    fn detects_offbeat_group_difference_when_score_marks_offbeat_targets() {
        let mut judgments = Vec::new();
        let mut context = DiagnosticContext::new(true);
        for i in 0..12 {
            let err = if i % 2 == 1 { 55.0 } else { 5.0 };
            let mut j = judgment(i, Some(err), Grade::Good);
            let id = format!("t{i}");
            if i % 2 == 1 { context.offbeat_target_ids.push(id); }
            j.actual_at_ms = j.expected_at_ms.map(|t| t + err);
            judgments.push(j);
        }
        let report = diagnose_timing(&judgments, &context);
        assert!(report.diagnostics.iter().any(|d| d.issue == TimingIssue::OffbeatTiming));
    }

    #[test]
    fn maps_diagnosis_to_an_actionable_exercise() {
        let judgments = stable_late_judgments(12);
        let report = diagnose_timing(&judgments, &DiagnosticContext::new(true));
        let prescription = recommend_exercise(&report, Some(80)).unwrap();
        assert_eq!(prescription.exercise, ExerciseKind::CountSubdivision);
        assert_eq!(prescription.suggested_bpm, Some(80));
        assert!(prescription.require_unassisted_transfer_test);
    }

    #[test]
    fn mastery_requires_transfer_and_delayed_evidence_for_consolidated_state() {
        let policy = MasteryPolicy::default();
        let mut model = StudentModel::default();
        let make_attempt = |transfer_test, delayed_retest| MasteryAttempt {
            passed: true, trustworthy: true, target_count: 16, assisted: false,
            transfer_test, delayed_retest,
        };

        for _ in 0..3 {
            model.observe_attempt("offbeat", make_attempt(false, false), &policy);
        }
        assert_eq!(model.get("offbeat").unwrap().state, MasteryState::Provisional);

        model.observe_attempt("offbeat", make_attempt(true, false), &policy);
        model.observe_attempt("offbeat", make_attempt(true, false), &policy);
        assert_eq!(model.get("offbeat").unwrap().state, MasteryState::Provisional);

        model.observe_attempt("offbeat", make_attempt(false, true), &policy);
        assert_eq!(model.get("offbeat").unwrap().state, MasteryState::Consolidated);
    }

    #[test]
    fn untrustworthy_attempt_does_not_update_mastery_or_create_entries() {
        let policy = MasteryPolicy::default();
        let mut model = StudentModel::default();
        let state = model.observe_attempt("pulse", MasteryAttempt {
            passed: true, trustworthy: false, target_count: 16, assisted: false,
            transfer_test: true, delayed_retest: true,
        }, &policy);
        assert_eq!(state, MasteryState::NotAssessed);
        assert!(model.get("pulse").is_none(), "no evidence means no skill entry");
        assert_eq!(model.snapshot().len(), 0);

        // An untrusted attempt against a known skill leaves its state untouched.
        for _ in 0..3 {
            model.observe_attempt("pulse", MasteryAttempt {
                passed: true, trustworthy: true, target_count: 16, assisted: false,
                transfer_test: false, delayed_retest: false,
            }, &policy);
        }
        let state = model.observe_attempt("pulse", MasteryAttempt {
            passed: false, trustworthy: false, target_count: 16, assisted: false,
            transfer_test: true, delayed_retest: true,
        }, &policy);
        assert_eq!(state, MasteryState::Provisional, "untrusted data cannot demote a skill");
        assert_eq!(model.get("pulse").unwrap().trustworthy_attempts, 3);
    }

    #[test]
    fn snapshot_round_trips_preserving_progress() {
        let policy = MasteryPolicy::default();
        let mut model = StudentModel::default();
        for _ in 0..3 {
            model.observe_attempt("offbeat", MasteryAttempt {
                passed: true, trustworthy: true, target_count: 16, assisted: false,
                transfer_test: false, delayed_retest: false,
            }, &policy);
        }
        let snapshot = model.snapshot();
        assert_eq!(snapshot.len(), 1);
        let restored = StudentModel::restore(snapshot).unwrap();
        assert_eq!(restored.get("offbeat"), model.get("offbeat"));

        // Restored model keeps accumulating evidence exactly where it stopped.
        let mut continued = restored;
        continued.observe_attempt("offbeat", MasteryAttempt {
            passed: false, trustworthy: true, target_count: 16, assisted: false,
            transfer_test: false, delayed_retest: false,
        }, &policy);
        assert_eq!(continued.get("offbeat").unwrap().consecutive_passes, 0);
        assert_eq!(continued.get("offbeat").unwrap().trustworthy_attempts, 4);
    }

    #[test]
    fn restore_rejects_duplicate_and_empty_skill_ids() {
        let entry = SkillProgress {
            skill_id: "offbeat".to_string(),
            state: MasteryState::Developing,
            trustworthy_attempts: 1,
            consecutive_passes: 1,
            transfer_passes: 0,
            delayed_passes: 0,
            last_attempt_passed: Some(true),
        };
        assert!(StudentModel::restore(vec![entry.clone(), entry.clone()]).is_err());

        let empty_id = SkillProgress { skill_id: "  ".to_string(), ..entry.clone() };
        assert!(StudentModel::restore(vec![empty_id]).is_err());

        assert_eq!(StudentModel::restore(Vec::new()).unwrap().skill_count(), 0);
    }
}
