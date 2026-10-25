use std::collections::HashMap;

use napi::{Error, Status};
use napi_derive::napi;
use rhythm_core::take::{
    CaptureRouter, CommandEnvelope, CommandId, EventId, MidiEventKind as TakeMidiEventKind,
    PerformanceTake, PracticeSession, PracticeSessionCommand, PracticeSessionId, PracticeSessionState,
    ProfileSnapshotId, ScoreFingerprint, SessionError, SourceId, StampedMidiPacket, TakeCommand, TakeId,
    TransitionReceipt,
};
use rhythm_core::{
    assess_durations, assess_presses_with_pauses, build_schedule, decode_ingest_packet, diagnose_timing,
    recommend_exercise, track_key_lifecycles, AtomKind, ClockQuality, DecodedMidiEvent,
    DiagnosticContext, DiagnosisReport,
    Diagnostic as TeachingDiagnostic, DiagnosisThresholds, DurationPolicy,
    DurationPolicyKind, DurationReport, EngineDiagnostics, EvidenceConfidence,
    ExercisePrescription, IngestMidiPacket, InputSource, Judgment, JudgmentProfile, MasteryAttempt,
    MasteryPolicy, MidiEventKind, MidiEventOriginalEncoding, MidiTransport, RawMidiNoteEvent,
    RawMidiPacket, RawNoteKind, RhythmAtom, RhythmPattern, ScoreStats, Severity, SessionEngine,
    SessionReport, SkillProgress, StrikeEvent, StudentModel, TargetHit, TimingFeatures, TimingIssue,
};

fn napi_error(error: impl std::fmt::Display) -> Error {
    Error::new(Status::InvalidArg, error.to_string())
}

fn to_u64(value: f64, field: &str) -> napi::Result<u64> {
    // JavaScript Number exactly represents integers only through 2^53 - 1.
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > MAX_SAFE_INTEGER {
        return Err(napi_error(format!("{field} must be a non-negative safe integer")));
    }
    Ok(value as u64)
}

#[napi(object)]
pub struct JsRhythmAtom {
    pub start_tick: f64,
    pub duration_ticks: f64,
    pub kind: String,
    pub bar: u32,
    pub beat: f64,
}

#[napi(object)]
pub struct JsRhythmPattern {
    pub id: String,
    pub ticks_per_quarter: u32,
    pub atoms: Vec<JsRhythmAtom>,
}

#[napi(object)]
pub struct JsTarget {
    pub id: String,
    pub index: Option<u32>,
    pub at_ms: f64,
    pub bar: Option<u32>,
    pub beat: Option<f64>,
    pub perfect_window_ms: f64,
    pub good_window_ms: f64,
    pub nominal_duration_ms: f64,
}

#[napi(object)]
pub struct JsStrikeEvent {
    pub seq: f64,
    pub at_ms: f64,
    pub source: String,
    pub notes: Vec<u32>,
    pub velocity: Option<u32>,
}

#[napi(object)]
pub struct JsJudgment {
    pub grade: String,
    pub target_id: Option<String>,
    pub target_index: Option<u32>,
    pub strike_seq: Option<f64>,
    pub error_ms: Option<f64>,
    pub expected_at_ms: Option<f64>,
    pub actual_at_ms: Option<f64>,
    pub bar: Option<u32>,
    pub beat: Option<f64>,
}

#[napi(object)]
pub struct JsScoreStats {
    pub target_count: u32,
    pub perfect_count: u32,
    pub good_count: u32,
    pub miss_count: u32,
    pub extra_count: u32,
    pub perfect_rate: f64,
    pub target_hit_rate: f64,
    pub miss_rate: f64,
    pub mean_signed_ms: Option<f64>,
    pub mean_absolute_ms: Option<f64>,
    pub standard_deviation_ms: Option<f64>,
}

#[napi(object)]
pub struct JsDiagnostics {
    pub received_events: u32,
    pub queue_overflow_count: u32,
    pub sequence_gap_count: u32,
    pub duplicate_or_regressing_sequence_count: u32,
    pub out_of_order_timestamp_count: u32,
    pub invalid_event_count: u32,
    pub late_arrival_count: u32,
}

#[napi(object)]
pub struct JsSessionReport {
    pub state: String,
    pub target_count: u32,
    pub raw_events: Vec<JsStrikeEvent>,
    pub judgments: Vec<JsJudgment>,
    pub stats: JsScoreStats,
    pub diagnostics: JsDiagnostics,
    pub trustworthy: bool,
}

fn to_core_target(target: JsTarget, index: usize) -> TargetHit {
    TargetHit {
        id: target.id,
        index,
        at_ms: target.at_ms,
        bar: target.bar,
        beat: target.beat,
        perfect_window_ms: target.perfect_window_ms,
        good_window_ms: target.good_window_ms,
        nominal_duration_ms: target.nominal_duration_ms,
    }
}

fn to_core_event(event: JsStrikeEvent) -> napi::Result<StrikeEvent> {
    let seq = to_u64(event.seq, "seq")?;
    let source = match event.source.as_str() {
        "midi" => InputSource::Midi,
        "keyboard" => InputSource::Keyboard,
        other => return Err(napi_error(format!("unknown source `{other}`; use midi or keyboard"))),
    };
    if event.notes.iter().any(|note| *note > 127) {
        return Err(napi_error("notes must contain MIDI note numbers in 0..=127"));
    }
    let notes = event.notes.into_iter().map(|note| note as u8).collect();
    let velocity = match event.velocity {
        Some(value) if value <= 127 => Some(value as u8),
        Some(_) => return Err(napi_error("velocity must be in 0..=127")),
        None => None,
    };
    let core = StrikeEvent { seq, at_ms: event.at_ms, source, notes, velocity };
    core.validate().map_err(napi_error)?;
    Ok(core)
}

fn to_js_event(event: &StrikeEvent) -> JsStrikeEvent {
    JsStrikeEvent {
        seq: event.seq as f64,
        at_ms: event.at_ms,
        source: match event.source { InputSource::Midi => "midi", InputSource::Keyboard => "keyboard" }.to_string(),
        notes: event.notes.iter().map(|value| *value as u32).collect(),
        velocity: event.velocity.map(|value| value as u32),
    }
}

fn to_js_target(target: &TargetHit) -> JsTarget {
    JsTarget {
        id: target.id.clone(), index: Some(target.index as u32), at_ms: target.at_ms,
        bar: target.bar, beat: target.beat,
        perfect_window_ms: target.perfect_window_ms, good_window_ms: target.good_window_ms,
        nominal_duration_ms: target.nominal_duration_ms,
    }
}

fn to_js_judgment(judgment: &Judgment) -> JsJudgment {
    JsJudgment {
        grade: judgment.grade.as_str().to_string(),
        target_id: judgment.target_id.clone(),
        target_index: judgment.target_index.map(|value| value as u32),
        strike_seq: judgment.strike_seq.map(|value| value as f64),
        error_ms: judgment.error_ms,
        expected_at_ms: judgment.expected_at_ms,
        actual_at_ms: judgment.actual_at_ms,
        bar: judgment.bar,
        beat: judgment.beat,
    }
}


fn to_core_judgment(judgment: JsJudgment) -> napi::Result<Judgment> {
    let grade = match judgment.grade.as_str() {
        "perfect" => rhythm_core::Grade::Perfect,
        "good" => rhythm_core::Grade::Good,
        "miss" => rhythm_core::Grade::Miss,
        "extra" => rhythm_core::Grade::Extra,
        other => return Err(napi_error(format!("unknown judgment grade `{other}`"))),
    };
    let strike_seq = match judgment.strike_seq {
        Some(value) => Some(to_u64(value, "strike_seq")?),
        None => None,
    };
    if judgment.error_ms.is_some_and(|v| !v.is_finite())
        || judgment.expected_at_ms.is_some_and(|v| !v.is_finite())
        || judgment.actual_at_ms.is_some_and(|v| !v.is_finite())
        || judgment.beat.is_some_and(|v| !v.is_finite())
    {
        return Err(napi_error("judgment timing fields must be finite when provided"));
    }
    Ok(Judgment {
        grade,
        target_id: judgment.target_id,
        target_index: judgment.target_index.map(|value| value as usize),
        strike_seq,
        error_ms: judgment.error_ms,
        expected_at_ms: judgment.expected_at_ms,
        actual_at_ms: judgment.actual_at_ms,
        bar: judgment.bar,
        beat: judgment.beat,
    })
}

#[napi(object)]
pub struct JsDiagnosisContext {
    pub measurement_trustworthy: bool,
    pub rest_reentry_target_ids: Vec<String>,
    pub offbeat_target_ids: Vec<String>,
}

#[napi(object)]
pub struct JsTimingFeatures {
    pub target_count: u32,
    pub matched_count: u32,
    pub miss_count: u32,
    pub extra_count: u32,
    pub miss_rate: f64,
    pub extra_rate: f64,
    pub mean_signed_error_ms: Option<f64>,
    pub median_signed_error_ms: Option<f64>,
    pub mean_absolute_error_ms: Option<f64>,
    pub standard_deviation_ms: Option<f64>,
    pub drift_ms_per_target: Option<f64>,
    pub rest_reentry_count: u32,
    pub rest_reentry_mean_signed_ms: Option<f64>,
    pub non_reentry_mean_signed_ms: Option<f64>,
    pub offbeat_count: u32,
    pub offbeat_mean_absolute_ms: Option<f64>,
    pub non_offbeat_mean_absolute_ms: Option<f64>,
}

#[napi(object)]
pub struct JsDiagnostic {
    pub issue: String,
    pub severity: String,
    pub confidence: String,
    pub evidence: String,
}

#[napi(object)]
pub struct JsDiagnosisReport {
    pub trustworthy: bool,
    pub features: JsTimingFeatures,
    pub diagnostics: Vec<JsDiagnostic>,
}

#[napi(object)]
pub struct JsExercisePrescription {
    pub target_issue: String,
    pub exercise: String,
    pub suggested_bpm: Option<u32>,
    pub metronome_mode: String,
    pub loops_per_set: u32,
    pub required_consecutive_passes: u32,
    pub maximum_mean_absolute_error_ms: f64,
    pub require_unassisted_transfer_test: bool,
    pub rationale: String,
}

#[napi(object)]
pub struct JsTimingAnalysis {
    pub report: JsDiagnosisReport,
    pub prescription: Option<JsExercisePrescription>,
}

fn issue_as_str(issue: TimingIssue) -> &'static str { issue.as_str() }

fn severity_as_str(severity: Severity) -> &'static str {
    match severity {
        Severity::Info => "info",
        Severity::Moderate => "moderate",
        Severity::High => "high",
    }
}

fn confidence_as_str(confidence: EvidenceConfidence) -> &'static str {
    match confidence {
        EvidenceConfidence::Low => "low",
        EvidenceConfidence::Medium => "medium",
        EvidenceConfidence::High => "high",
    }
}

fn to_js_features(features: TimingFeatures) -> JsTimingFeatures {
    JsTimingFeatures {
        target_count: features.target_count as u32,
        matched_count: features.matched_count as u32,
        miss_count: features.miss_count as u32,
        extra_count: features.extra_count as u32,
        miss_rate: features.miss_rate,
        extra_rate: features.extra_rate,
        mean_signed_error_ms: features.mean_signed_error_ms,
        median_signed_error_ms: features.median_signed_error_ms,
        mean_absolute_error_ms: features.mean_absolute_error_ms,
        standard_deviation_ms: features.standard_deviation_ms,
        drift_ms_per_target: features.drift_ms_per_target,
        rest_reentry_count: features.rest_reentry_count as u32,
        rest_reentry_mean_signed_ms: features.rest_reentry_mean_signed_ms,
        non_reentry_mean_signed_ms: features.non_reentry_mean_signed_ms,
        offbeat_count: features.offbeat_count as u32,
        offbeat_mean_absolute_ms: features.offbeat_mean_absolute_ms,
        non_offbeat_mean_absolute_ms: features.non_offbeat_mean_absolute_ms,
    }
}

fn to_js_diagnostic(diagnostic: TeachingDiagnostic) -> JsDiagnostic {
    JsDiagnostic {
        issue: issue_as_str(diagnostic.issue).to_string(),
        severity: severity_as_str(diagnostic.severity).to_string(),
        confidence: confidence_as_str(diagnostic.confidence).to_string(),
        evidence: diagnostic.evidence,
    }
}

fn to_js_diagnosis_report(report: DiagnosisReport) -> JsDiagnosisReport {
    JsDiagnosisReport {
        trustworthy: report.trustworthy,
        features: to_js_features(report.features),
        diagnostics: report.diagnostics.into_iter().map(to_js_diagnostic).collect(),
    }
}

fn to_js_prescription(prescription: ExercisePrescription) -> JsExercisePrescription {
    JsExercisePrescription {
        target_issue: issue_as_str(prescription.target_issue).to_string(),
        exercise: prescription.exercise.as_str().to_string(),
        suggested_bpm: prescription.suggested_bpm.map(|v| v as u32),
        metronome_mode: match prescription.metronome_mode {
            rhythm_core::MetronomeMode::EveryBeat => "every_beat",
            rhythm_core::MetronomeMode::BeatOneOnly => "beat_one_only",
            rhythm_core::MetronomeMode::Silent => "silent",
        }.to_string(),
        loops_per_set: prescription.loops_per_set as u32,
        required_consecutive_passes: prescription.required_consecutive_passes as u32,
        maximum_mean_absolute_error_ms: prescription.maximum_mean_absolute_error_ms,
        require_unassisted_transfer_test: prescription.require_unassisted_transfer_test,
        rationale: prescription.rationale,
    }
}

/// Run deterministic rule-based timing diagnosis after the final score is available.
/// Context target IDs should come from the imported score, not be guessed by the UI.
#[napi(js_name = "analyzeTiming")]
pub fn js_analyze_timing(
    judgments: Vec<JsJudgment>,
    context: JsDiagnosisContext,
    current_bpm: Option<u32>,
) -> napi::Result<JsTimingAnalysis> {
    if current_bpm.is_some_and(|bpm| !(20..=300).contains(&bpm)) {
        return Err(napi_error("current_bpm must be between 20 and 300"));
    }
    let judgments = judgments.into_iter().map(to_core_judgment).collect::<napi::Result<Vec<_>>>()?;
    let core_context = DiagnosticContext {
        measurement_trustworthy: context.measurement_trustworthy,
        rest_reentry_target_ids: context.rest_reentry_target_ids,
        offbeat_target_ids: context.offbeat_target_ids,
        thresholds: DiagnosisThresholds::default(),
    };
    let report = diagnose_timing(&judgments, &core_context);
    let prescription = recommend_exercise(&report, current_bpm.map(|bpm| bpm as u16));
    Ok(JsTimingAnalysis {
        report: to_js_diagnosis_report(report),
        prescription: prescription.map(to_js_prescription),
    })
}

fn to_js_stats(stats: &ScoreStats) -> JsScoreStats {
    JsScoreStats {
        target_count: stats.target_count as u32,
        perfect_count: stats.perfect_count as u32,
        good_count: stats.good_count as u32,
        miss_count: stats.miss_count as u32,
        extra_count: stats.extra_count as u32,
        perfect_rate: stats.perfect_rate,
        target_hit_rate: stats.target_hit_rate,
        miss_rate: stats.miss_rate,
        mean_signed_ms: stats.mean_signed_ms,
        mean_absolute_ms: stats.mean_absolute_ms,
        standard_deviation_ms: stats.standard_deviation_ms,
    }
}

fn to_js_diagnostics(diagnostics: &EngineDiagnostics) -> JsDiagnostics {
    JsDiagnostics {
        received_events: diagnostics.received_events as u32,
        queue_overflow_count: diagnostics.queue_overflow_count as u32,
        sequence_gap_count: diagnostics.sequence_gap_count as u32,
        duplicate_or_regressing_sequence_count: diagnostics.duplicate_or_regressing_sequence_count as u32,
        out_of_order_timestamp_count: diagnostics.out_of_order_timestamp_count as u32,
        invalid_event_count: diagnostics.invalid_event_count as u32,
        late_arrival_count: diagnostics.late_arrival_count as u32,
    }
}

fn to_js_report(report: SessionReport) -> JsSessionReport {
    JsSessionReport {
        state: report.state.as_str().to_string(),
        target_count: report.target_count as u32,
        raw_events: report.raw_events.iter().map(to_js_event).collect(),
        judgments: report.judgments.iter().map(to_js_judgment).collect(),
        stats: to_js_stats(&report.stats),
        diagnostics: to_js_diagnostics(&report.diagnostics),
        trustworthy: report.trustworthy,
    }
}

#[napi(js_name = "buildSchedule")]
pub fn js_build_schedule(
    pattern: JsRhythmPattern,
    bpm: f64,
    start_at_ms: f64,
    profile: String,
) -> napi::Result<Vec<JsTarget>> {
    let profile = match profile.as_str() {
        "strict" => JudgmentProfile::strict(),
        "standard" => JudgmentProfile::standard(),
        "relaxed" => JudgmentProfile::relaxed(),
        _ => return Err(napi_error("profile must be strict, standard, or relaxed")),
    };
    let atoms = pattern.atoms.into_iter().map(|atom| {
        let start_tick = to_u64(atom.start_tick, "start_tick")?;
        let duration_ticks = to_u64(atom.duration_ticks, "duration_ticks")?;
        let kind = match atom.kind.as_str() {
            "note" => AtomKind::Note,
            "rest" => AtomKind::Rest,
            other => return Err(napi_error(format!("unknown atom kind `{other}`; use note or rest"))),
        };
        Ok(RhythmAtom { start_tick, duration_ticks, kind, bar: atom.bar, beat: atom.beat })
    }).collect::<napi::Result<Vec<_>>>()?;
    let core_pattern = RhythmPattern { id: pattern.id, ticks_per_quarter: pattern.ticks_per_quarter, atoms };
    build_schedule(&core_pattern, bpm, start_at_ms, profile)
        .map(|targets| targets.iter().map(to_js_target).collect())
        .map_err(napi_error)
}

#[napi(object)]
pub struct JsRawNoteEvent {
    pub seq: f64,
    pub at_ms: f64,
    /// "note_on" | "note_off"
    pub kind: String,
    pub pitch: u32,
    pub velocity: Option<u32>,
}

#[napi(object)]
pub struct JsDurationPolicy {
    /// "strict-keydown" | "disabled"
    pub policy: String,
    pub tolerance_ms: f64,
    pub tolerance_ratio: f64,
    /// Flat source-clock pairs `[pauseStartMs, resumeEndMs, ...]`. Omit when
    /// the take had no pause boundaries. Intervals are in the same source clock
    /// as `KeyPressObservation.start_source_time_ms`.
    pub pause_intervals_source_ms: Option<Vec<f64>>,
}

#[napi(object)]
pub struct JsDurationAssessment {
    pub target_index: Option<u32>,
    pub target_id: Option<String>,
    pub onset_seq: Option<f64>,
    pub pitch: Option<u32>,
    pub nominal_duration_ms: Option<f64>,
    pub actual_key_down_ms: Option<f64>,
    pub duration_error_ms: Option<f64>,
    pub allowed_error_ms: Option<f64>,
    pub inter_onset_interval_ms: Option<f64>,
    /// "within_tolerance" | "too_short" | "too_long" | "unknown" | "disabled"
    pub result: String,
    /// "ok" | "overlapping_same_pitch" | "open_note_interrupted"
    pub quality: String,
}

#[napi(object)]
pub struct JsDurationReport {
    pub policy_version: u32,
    pub assessments: Vec<JsDurationAssessment>,
    pub orphan_note_off_count: u32,
    pub open_note_count: u32,
}

fn to_core_raw_note(event: JsRawNoteEvent) -> napi::Result<RawMidiNoteEvent> {
    let seq = to_u64(event.seq, "seq")?;
    let kind = match RawNoteKind::from_str(event.kind.as_str()) {
        Some(kind) => kind,
        None => return Err(napi_error(format!("unknown note kind `{}`; use note_on or note_off", event.kind))),
    };
    if event.pitch > 127 {
        return Err(napi_error("pitch must be within 0..=127"));
    }
    let velocity = match event.velocity {
        Some(v) if v <= 127 => Some(v as u8),
        Some(_) => return Err(napi_error("velocity must be in 0..=127")),
        None => None,
    };
    Ok(RawMidiNoteEvent { seq, at_ms: event.at_ms, kind, pitch: event.pitch as u8, velocity })
}

/// Pair Note On/Off and assess key-down durations against the target schedule.
/// Onset scoring (the judgments) is the alignment source; durations never
/// overwrite onset grades.
#[napi(js_name = "assessDurations")]
pub fn js_assess_durations(
    targets: Vec<JsTarget>,
    raw_events: Vec<JsRawNoteEvent>,
    judgments: Vec<JsJudgment>,
    policy: JsDurationPolicy,
) -> napi::Result<JsDurationReport> {
    let core_targets = targets.into_iter().enumerate().map(|(index, target)| to_core_target(target, index)).collect::<Vec<_>>();
    let core_events = raw_events.into_iter().map(to_core_raw_note).collect::<napi::Result<Vec<_>>>()?;
    let core_judgments = judgments.into_iter().map(to_core_judgment).collect::<napi::Result<Vec<_>>>()?;
    let kind = match policy.policy.as_str() {
        "strict-keydown" => DurationPolicyKind::StrictKeyDown,
        "disabled" => DurationPolicyKind::Disabled,
        other => return Err(napi_error(format!("unknown duration policy `{other}`; use strict-keydown or disabled"))),
    };
    let core_policy = DurationPolicy {
        kind,
        tolerance_ms: policy.tolerance_ms,
        tolerance_ratio: policy.tolerance_ratio,
    };
    let report: DurationReport = assess_durations(&core_targets, &core_events, &core_judgments, &core_policy)
        .map_err(napi_error)?;
    Ok(JsDurationReport {
        policy_version: report.policy_version,
        orphan_note_off_count: report.orphan_note_off_count as u32,
        open_note_count: report.open_note_count as u32,
        assessments: report.assessments.into_iter().map(|a| JsDurationAssessment {
            target_index: a.target_index.map(|v| v as u32),
            target_id: a.target_id,
            onset_seq: a.onset_seq.map(|v| v as f64),
            pitch: a.pitch.map(|v| v as u32),
            nominal_duration_ms: a.nominal_duration_ms,
            actual_key_down_ms: a.actual_key_down_ms,
            duration_error_ms: a.duration_error_ms,
            allowed_error_ms: a.allowed_error_ms,
            inter_onset_interval_ms: a.inter_onset_interval_ms,
            result: a.result.as_str().to_string(),
            quality: a.quality.as_str().to_string(),
        }).collect(),
    })
}

// ---------------------------------------------------------------------------
// v0.6 raw packet contract: decode + key lifecycle tracking (authoritative).

#[napi(object)]
pub struct JsRawMidiPacket {
    pub source_id: String,
    pub source_seq: f64,
    pub clock_domain_id: String,
    pub captured_at_ms: f64,
    pub handler_at_ms: Option<f64>,
    pub raw_bytes: Vec<u32>,
    /// "web-midi" | "node-midi" | "mock" | "recording"
    pub transport: String,
}

#[napi(object)]
pub struct JsIngestMidiPacket {
    pub packet: JsRawMidiPacket,
    pub session_time_ms: Option<f64>,
    pub clock_mapping_id: Option<String>,
    pub clock_uncertainty_ms: Option<f64>,
    /// "good" | "estimated" | "unstable" | "unknown"
    pub clock_quality: Option<String>,
}

#[napi(object)]
pub struct JsDecodedMidiEvent {
    pub event_id: String,
    pub source_id: String,
    pub source_seq: f64,
    pub channel: Option<u32>,
    pub source_time_ms: f64,
    pub session_time_ms: Option<f64>,
    pub clock_domain_id: String,
    pub clock_quality: String,
    /// "note-on" | "note-off" | "control-change" | "polyphonic-key-pressure"
    /// | "channel-pressure" | "program-change" | "pitch-bend" | "other"
    pub kind: String,
    pub complete: bool,
    /// For note-off: "0x8n" | "0x9n-zero-velocity"
    pub original_encoding: Option<String>,
    pub note_number: Option<u32>,
    pub velocity: Option<u32>,
    pub controller: Option<u32>,
    pub value: Option<u32>,
    pub program: Option<u32>,
    pub pressure: Option<u32>,
    pub pitch_bend_value: Option<f64>,
}

fn to_core_ingest(ingest: JsIngestMidiPacket) -> napi::Result<IngestMidiPacket> {
    let packet = ingest.packet;
    let transport = MidiTransport::from_str(packet.transport.as_str())
        .ok_or_else(|| napi_error(format!("unknown transport `{}`", packet.transport)))?;
    if packet.raw_bytes.iter().any(|b| *b > 255) {
        return Err(napi_error("raw_bytes must contain bytes (0..=255)"));
    }
    let clock_quality = ingest.clock_quality.as_deref()
        .and_then(ClockQuality::from_str)
        .unwrap_or(ClockQuality::Unknown);
    Ok(IngestMidiPacket {
        packet: RawMidiPacket {
            source_id: packet.source_id,
            source_seq: to_u64(packet.source_seq, "packet.sourceSeq")?,
            clock_domain_id: packet.clock_domain_id,
            captured_at_ms: packet.captured_at_ms,
            handler_at_ms: packet.handler_at_ms,
            raw_bytes: packet.raw_bytes.into_iter().map(|b| b as u8).collect(),
            transport,
        },
        session_time_ms: ingest.session_time_ms,
        clock_mapping_id: ingest.clock_mapping_id,
        clock_uncertainty_ms: ingest.clock_uncertainty_ms,
        clock_quality,
    })
}

fn decoded_kind_str(kind: &MidiEventKind) -> String {
    match kind {
        MidiEventKind::NoteOn { .. } => "note-on".to_string(),
        MidiEventKind::NoteOff { .. } => "note-off".to_string(),
        MidiEventKind::ControlChange { .. } => "control-change".to_string(),
        MidiEventKind::PolyphonicKeyPressure { .. } => "polyphonic-key-pressure".to_string(),
        MidiEventKind::ChannelPressure { .. } => "channel-pressure".to_string(),
        MidiEventKind::ProgramChange { .. } => "program-change".to_string(),
        MidiEventKind::PitchBend { .. } => "pitch-bend".to_string(),
        MidiEventKind::Other { .. } => "other".to_string(),
    }
}

fn to_js_decoded(event: DecodedMidiEvent) -> JsDecodedMidiEvent {
    let kind_str = decoded_kind_str(&event.kind);
    let (note_number, velocity, controller, value, program, pressure, pitch_bend_value) = match event.kind {
        MidiEventKind::NoteOn { note_number, velocity } => (Some(note_number as u32), Some(velocity as u32), None, None, None, None, None),
        MidiEventKind::NoteOff { note_number, release_velocity } => (Some(note_number as u32), release_velocity.map(|v| v as u32), None, None, None, None, None),
        MidiEventKind::ControlChange { controller, value } => (None, None, Some(controller as u32), Some(value as u32), None, None, None),
        MidiEventKind::PolyphonicKeyPressure { note_number, pressure } => (Some(note_number as u32), None, None, None, None, Some(pressure as u32), None),
        MidiEventKind::ChannelPressure { pressure } => (None, None, None, None, None, Some(pressure as u32), None),
        MidiEventKind::ProgramChange { program } => (None, None, None, None, Some(program as u32), None, None),
        MidiEventKind::PitchBend { value_14bit } => (None, None, None, None, None, None, Some(value_14bit as f64)),
        MidiEventKind::Other { .. } => (None, None, None, None, None, None, None),
    };
    JsDecodedMidiEvent {
        event_id: event.event_id,
        source_id: event.source_id,
        source_seq: event.source_seq as f64,
        channel: event.channel.map(|c| c as u32),
        source_time_ms: event.source_time_ms,
        session_time_ms: event.session_time_ms,
        clock_domain_id: event.clock_domain_id,
        clock_quality: event.clock_quality.as_str().to_string(),
        kind: kind_str,
        complete: event.complete,
        original_encoding: event.original_encoding.map(|e| e.as_str().to_string()),
        note_number,
        velocity,
        controller,
        value,
        program,
        pressure,
        pitch_bend_value,
    }
}

/// Decodes raw packets with the authoritative Rust decoder (v0.6). Adapters
/// must route every packet here — no TypeScript-side semantic decoding may
/// feed the scoring path.
#[napi(js_name = "decodeMidiPackets")]
pub fn js_decode_midi_packets(ingests: Vec<JsIngestMidiPacket>) -> napi::Result<Vec<JsDecodedMidiEvent>> {
    ingests.into_iter()
        .map(|ingest| {
            let core_ingest = to_core_ingest(ingest)?;
            decode_ingest_packet(&core_ingest).map(to_js_decoded).map_err(napi_error)
        })
        .collect()
}

#[napi(object)]
pub struct JsKeyPressObservation {
    pub press_id: String,
    pub source_id: String,
    pub channel: u32,
    pub note_number: u32,
    pub velocity_on: u32,
    pub note_on_event_id: String,
    pub note_off_event_id: Option<String>,
    pub start_source_time_ms: f64,
    pub end_source_time_ms: Option<f64>,
    pub key_down_duration_ms: Option<f64>,
    /// "complete" | "missing-note-off" | "interrupted-by-disconnect"
    /// | "ambiguous-pairing" | "invalid-time"
    pub status: String,
    pub quality_reasons: Vec<String>,
    pub note_on_source_seq: f64,
}

#[napi(object)]
pub struct JsMidiDiagnostic {
    pub code: String,
    pub source_id: String,
    pub source_seq: Option<f64>,
    pub detail: String,
}

#[napi(object)]
pub struct JsKeyLifecycleReport {
    pub schema_version: u32,
    pub algorithm_version: String,
    pub observations: Vec<JsKeyPressObservation>,
    pub diagnostics: Vec<JsMidiDiagnostic>,
}

/// Tracks key press lifecycles from raw packets: same authoritative path as
/// live sessions. Deterministic — the same packet sequence yields the same
/// report on every replay.
#[napi(js_name = "trackKeyLifecycles")]
pub fn js_track_key_lifecycles(ingests: Vec<JsIngestMidiPacket>) -> napi::Result<JsKeyLifecycleReport> {
    let core_ingests = ingests.into_iter().map(to_core_ingest).collect::<napi::Result<Vec<_>>>()?;
    let report = track_key_lifecycles(&core_ingests).map_err(napi_error)?;
    Ok(JsKeyLifecycleReport {
        schema_version: report.schema_version,
        algorithm_version: report.algorithm_version,
        observations: report.observations.into_iter().map(|o| JsKeyPressObservation {
            press_id: o.press_id,
            source_id: o.source_id,
            channel: o.channel as u32,
            note_number: o.note_number as u32,
            velocity_on: o.velocity_on as u32,
            note_on_event_id: o.note_on_event_id,
            note_off_event_id: o.note_off_event_id,
            start_source_time_ms: o.start_source_time_ms,
            end_source_time_ms: o.end_source_time_ms,
            key_down_duration_ms: o.key_down_duration_ms,
            status: o.status.as_str().to_string(),
            quality_reasons: o.quality_reasons,
            note_on_source_seq: o.note_on_source_seq as f64,
        }).collect(),
        diagnostics: report.diagnostics.into_iter().map(|d| JsMidiDiagnostic {
            code: d.code.to_string(),
            source_id: d.source_id,
            source_seq: d.source_seq.map(|v| v as f64),
            detail: d.detail,
        }).collect(),
    })
}

/// Grades key-down durations from tracker observations against the schedule.
/// Only `complete` presses are strictly graded; ambiguous / missing /
/// interrupted presses yield "unknown".
#[napi(js_name = "assessKeyPresses")]
pub fn js_assess_key_presses(
    targets: Vec<JsTarget>,
    presses: Vec<JsKeyPressObservation>,
    judgments: Vec<JsJudgment>,
    policy: JsDurationPolicy,
) -> napi::Result<JsDurationReport> {
    let core_targets = targets.into_iter().enumerate().map(|(index, target)| to_core_target(target, index)).collect::<Vec<_>>();
    let core_policy_policy = match policy.policy.as_str() {
        "strict-keydown" => DurationPolicyKind::StrictKeyDown,
        "disabled" => DurationPolicyKind::Disabled,
        other => return Err(napi_error(format!("unknown duration policy `{other}`"))),
    };
    let core_policy = DurationPolicy {
        kind: core_policy_policy,
        tolerance_ms: policy.tolerance_ms,
        tolerance_ratio: policy.tolerance_ratio,
    };
    let core_judgments = judgments.into_iter().map(to_core_judgment).collect::<napi::Result<Vec<_>>>()?;
    let core_presses = presses.into_iter().map(|p| -> napi::Result<rhythm_core::KeyPressObservation> {
        Ok(rhythm_core::KeyPressObservation {
            press_id: p.press_id,
            source_id: p.source_id,
            channel: p.channel as u8,
            note_number: p.note_number as u8,
            velocity_on: p.velocity_on as u8,
            note_on_event_id: p.note_on_event_id,
            note_off_event_id: p.note_off_event_id,
            start_source_time_ms: p.start_source_time_ms,
            end_source_time_ms: p.end_source_time_ms,
            key_down_duration_ms: p.key_down_duration_ms,
            status: match p.status.as_str() {
                "complete" => rhythm_core::KeyPressStatus::Complete,
                "missing-note-off" => rhythm_core::KeyPressStatus::MissingNoteOff,
                "interrupted-by-disconnect" => rhythm_core::KeyPressStatus::InterruptedByDisconnect,
                "ambiguous-pairing" => rhythm_core::KeyPressStatus::AmbiguousPairing,
                "invalid-time" => rhythm_core::KeyPressStatus::InvalidTime,
                other => return Err(napi_error(format!("unknown press status `{other}`"))),
            },
            quality_reasons: p.quality_reasons,
            note_on_source_seq: to_u64(p.note_on_source_seq, "noteOnSourceSeq")?,
        })
    }).collect::<napi::Result<Vec<_>>>()?;
    let pause_flat = policy.pause_intervals_source_ms.unwrap_or_default();
    if pause_flat.len() % 2 != 0 {
        return Err(napi_error("pauseIntervalsSourceMs must contain [start, end] pairs"));
    }
    let mut pause_intervals = Vec::with_capacity(pause_flat.len() / 2);
    for pair in pause_flat.chunks_exact(2) {
        let (start, end) = (pair[0], pair[1]);
        if !start.is_finite() || !end.is_finite() || end <= start {
            return Err(napi_error("pause intervals must be finite and end > start"));
        }
        pause_intervals.push((start, end));
    }
    let report = assess_presses_with_pauses(
        &core_targets, &core_presses, &core_judgments, &core_policy, &pause_intervals,
    ).map_err(napi_error)?;
    Ok(to_js_duration_report(report))
}

fn to_js_duration_report(report: DurationReport) -> JsDurationReport {
    // Reuses the legacy duration assessment DTO shape.
    JsDurationReport {
        policy_version: report.policy_version,
        orphan_note_off_count: report.orphan_note_off_count as u32,
        open_note_count: report.open_note_count as u32,
        assessments: report.assessments.into_iter().map(|a| JsDurationAssessment {
            target_index: a.target_index.map(|v| v as u32),
            target_id: a.target_id,
            onset_seq: a.onset_seq.map(|v| v as f64),
            pitch: a.pitch.map(|v| v as u32),
            nominal_duration_ms: a.nominal_duration_ms,
            actual_key_down_ms: a.actual_key_down_ms,
            duration_error_ms: a.duration_error_ms,
            allowed_error_ms: a.allowed_error_ms,
            inter_onset_interval_ms: a.inter_onset_interval_ms,
            result: a.result.as_str().to_string(),
            quality: a.quality.as_str().to_string(),
        }).collect(),
    }
}

#[napi]
pub struct NativeSession {
    inner: SessionEngine,
}

#[napi(object)]
pub struct JsSkillProgress {
    pub skill_id: String,
    pub state: String,
    pub trustworthy_attempts: u32,
    pub consecutive_passes: u32,
    pub transfer_passes: u32,
    pub delayed_passes: u32,
    pub last_attempt_passed: Option<bool>,
}

#[napi(object)]
pub struct JsMasteryPolicy {
    pub minimum_targets_per_attempt: u32,
    pub required_consecutive_passes: u32,
    pub required_transfer_passes: u32,
    pub required_delayed_passes: u32,
}

#[napi(object)]
pub struct JsMasteryAttempt {
    pub passed: bool,
    pub trustworthy: bool,
    pub target_count: u32,
    pub assisted: bool,
    pub transfer_test: bool,
    pub delayed_retest: bool,
}

fn mastery_state_from_str(state: String) -> napi::Result<rhythm_core::MasteryState> {
    match state.as_str() {
        "not_assessed" => Ok(rhythm_core::MasteryState::NotAssessed),
        "developing" => Ok(rhythm_core::MasteryState::Developing),
        "provisional" => Ok(rhythm_core::MasteryState::Provisional),
        "consolidated" => Ok(rhythm_core::MasteryState::Consolidated),
        "needs_review" => Ok(rhythm_core::MasteryState::NeedsReview),
        other => Err(napi_error(format!("unknown mastery state `{other}`"))),
    }
}

fn to_js_skill_progress(progress: &SkillProgress) -> JsSkillProgress {
    JsSkillProgress {
        skill_id: progress.skill_id.clone(),
        state: progress.state.as_str().to_string(),
        trustworthy_attempts: progress.trustworthy_attempts,
        consecutive_passes: progress.consecutive_passes,
        transfer_passes: progress.transfer_passes,
        delayed_passes: progress.delayed_passes,
        last_attempt_passed: progress.last_attempt_passed,
    }
}

fn to_core_skill_progress(progress: JsSkillProgress) -> napi::Result<SkillProgress> {
    Ok(SkillProgress {
        skill_id: progress.skill_id,
        state: mastery_state_from_str(progress.state)?,
        trustworthy_attempts: progress.trustworthy_attempts,
        consecutive_passes: progress.consecutive_passes,
        transfer_passes: progress.transfer_passes,
        delayed_passes: progress.delayed_passes,
        last_attempt_passed: progress.last_attempt_passed,
    })
}

fn to_core_policy(policy: Option<JsMasteryPolicy>) -> MasteryPolicy {
    policy.map(|policy| MasteryPolicy {
        minimum_targets_per_attempt: policy.minimum_targets_per_attempt as usize,
        required_consecutive_passes: policy.required_consecutive_passes,
        required_transfer_passes: policy.required_transfer_passes,
        required_delayed_passes: policy.required_delayed_passes,
    }).unwrap_or_default()
}

/// Persistable rule-based student model. The host application owns JSON
/// persistence; this class only converts between JS objects and the core model.
#[napi]
pub struct NativeStudentModel {
    inner: StudentModel,
}

#[napi]
impl NativeStudentModel {
    /// Creates an empty model, or restores one from a previous `snapshot()` result.
    #[napi(constructor)]
    pub fn new(restore_from: Option<Vec<JsSkillProgress>>) -> napi::Result<Self> {
        let inner = match restore_from {
            Some(entries) => {
                let snapshot = entries.into_iter().map(to_core_skill_progress).collect::<napi::Result<Vec<_>>>()?;
                StudentModel::restore(snapshot).map_err(napi_error)?
            }
            None => StudentModel::default(),
        };
        Ok(Self { inner })
    }

    #[napi(js_name = "getSkill")]
    pub fn get_skill(&self, skill_id: String) -> Option<JsSkillProgress> {
        self.inner.get(&skill_id).map(to_js_skill_progress)
    }

    /// Records one quality-gated attempt and returns the resulting mastery state.
    #[napi(js_name = "observeAttempt")]
    pub fn observe_attempt(
        &mut self,
        skill_id: String,
        attempt: JsMasteryAttempt,
        policy: Option<JsMasteryPolicy>,
    ) -> napi::Result<String> {
        let core_attempt = MasteryAttempt {
            passed: attempt.passed,
            trustworthy: attempt.trustworthy,
            target_count: attempt.target_count as usize,
            assisted: attempt.assisted,
            transfer_test: attempt.transfer_test,
            delayed_retest: attempt.delayed_retest,
        };
        Ok(self.inner.observe_attempt(skill_id, core_attempt, &to_core_policy(policy)).as_str().to_string())
    }

    /// Deterministic snapshot for persistence; pass it back to the constructor
    /// to restore. Field names here are camelCase in JS via napi-rs defaults.
    #[napi]
    pub fn snapshot(&self) -> Vec<JsSkillProgress> {
        self.inner.snapshot().iter().map(to_js_skill_progress).collect()
    }

    #[napi(js_name = "skillCount")]
    pub fn skill_count(&self) -> u32 {
        self.inner.skill_count() as u32
    }
}

#[napi]
impl NativeSession {
    #[napi(constructor)]
    pub fn new(targets: Vec<JsTarget>, queue_capacity: u32, finalization_grace_ms: f64) -> napi::Result<Self> {
        let targets = targets.into_iter().enumerate().map(|(index, target)| to_core_target(target, index)).collect();
        let inner = SessionEngine::new(targets, queue_capacity as usize, finalization_grace_ms).map_err(napi_error)?;
        Ok(Self { inner })
    }

    #[napi]
    pub fn start(&mut self) -> napi::Result<()> { self.inner.start().map_err(napi_error) }

    #[napi(js_name = "pushHit")]
    pub fn push_hit(&mut self, event: JsStrikeEvent) -> napi::Result<bool> {
        self.inner.push_event(to_core_event(event)?).map_err(napi_error)?;
        Ok(true)
    }

    #[napi(js_name = "processPending")]
    pub fn process_pending(&mut self) -> napi::Result<Vec<JsJudgment>> {
        self.inner.process_pending().map(|items| items.iter().map(to_js_judgment).collect()).map_err(napi_error)
    }

    #[napi]
    pub fn advance(&mut self, now_ms: f64) -> napi::Result<Vec<JsJudgment>> {
        self.inner.advance(now_ms).map(|items| items.iter().map(to_js_judgment).collect()).map_err(napi_error)
    }

    #[napi]
    pub fn pause(&mut self, now_ms: f64) -> napi::Result<Vec<JsJudgment>> {
        self.inner.pause(now_ms).map(|items| items.iter().map(to_js_judgment).collect()).map_err(napi_error)
    }

    #[napi]
    pub fn resume(&mut self, now_ms: f64) -> napi::Result<()> { self.inner.resume(now_ms).map_err(napi_error) }

    #[napi]
    pub fn finish(&mut self) -> napi::Result<JsSessionReport> { self.inner.finish().map(to_js_report).map_err(napi_error) }

    #[napi]
    pub fn state(&self) -> String { self.inner.state().as_str().to_string() }
}

// ---------------------------------------------------------------------------
// PracticeSession / PerformanceTake coordinator (v0.6.2)
//
// The server holds one coordinator per WebSocket connection. It owns the
// authoritative Take lifecycle and capture epochs; the scoring engine remains
// per-Take. JSON-free NAPI objects keep the boundary explicit and avoid the
// Option/null serialization pitfall.

#[napi(object)]
pub struct JsTakeStart {
    pub practice_session_id: String,
    pub take_id: String,
    pub capture_epoch: f64,
    pub take_index: u32,
    pub state: String,
}

#[napi(object)]
pub struct JsTakeSnapshot {
    pub practice_session_id: String,
    pub session_state: String,
    pub session_version: f64,
    pub active_take_id: String,
    pub take_count: u32,
    pub take_id: String,
    pub take_state: String,
    pub take_version: f64,
    pub capture_epoch: f64,
    pub capture_started_at_ms: f64,
    pub capture_ended_at_ms: f64,
    pub input_health: String,
    pub finalization_status: String,
    pub report_revision: f64,
    pub accepted_packets: f64,
    pub quarantined_packets: f64,
    pub epoch_mismatch: f64,
    pub sequence_regression: f64,
    pub after_capture_stop: f64,
}

#[napi(object)]
pub struct JsRoutingDecision {
    pub accepted: bool,
    pub kind: String,
    pub take_id: String,
    pub expected_epoch: f64,
}

fn take_ms_to_ns(ms: f64) -> napi::Result<u64> {
    if !ms.is_finite() || ms < 0.0 {
        return Err(napi_error("time must be a finite non-negative millisecond value"));
    }
    const MAX_SAFE_MS: f64 = 9_007_199_254_740_991.0 / 1_000_000.0;
    if ms > MAX_SAFE_MS {
        return Err(napi_error("time is too large"));
    }
    Ok((ms * 1_000_000.0).round() as u64)
}

#[napi]
pub struct NativeTakeCoordinator {
    session: PracticeSession,
    takes: HashMap<TakeId, PerformanceTake>,
    router: CaptureRouter,
    next_take_index: u32,
    command_seq: u64,
    epoch_seq: u64,
    event_seq: u64,
}

#[napi]
impl NativeTakeCoordinator {
    #[napi(constructor)]
    pub fn new(session_id: String, score_fingerprint: String, profile_snapshot_id: String) -> Self {
        Self {
            session: PracticeSession::new(
                PracticeSessionId::new(session_id),
                ScoreFingerprint::new(score_fingerprint),
                ProfileSnapshotId::new(profile_snapshot_id),
            ),
            takes: HashMap::new(),
            router: CaptureRouter::default(),
            next_take_index: 1,
            command_seq: 0,
            epoch_seq: 0,
            event_seq: 0,
        }
    }

    fn next_command(&mut self, prefix: &str) -> CommandId {
        self.command_seq += 1;
        CommandId::new(format!("{prefix}-{}", self.command_seq))
    }

    fn ensure_session_ready(&mut self) -> napi::Result<()> {
        if self.session.state == PracticeSessionState::Draft {
            let version = self.session.state_version;
            let command_id = self.next_command("session-prepare");
            self.session
                .apply_command(command_id, version, PracticeSessionCommand::Prepare)
                .map_err(napi_error)?;
        }
        if self.session.state == PracticeSessionState::Preparing {
            let version = self.session.state_version;
            let command_id = self.next_command("session-ready");
            self.session
                .apply_command(command_id, version, PracticeSessionCommand::MarkReady)
                .map_err(napi_error)?;
        }
        match self.session.state {
            PracticeSessionState::Ready | PracticeSessionState::Active => Ok(()),
            _ => Err(napi_error(SessionError::SessionCommandInvalid)),
        }
    }

    #[napi(js_name = "beginTake")]
    pub fn begin_take(&mut self, at_ms: f64) -> napi::Result<JsTakeStart> {
        if self.session.active_take_id.is_some() {
            return Err(napi_error(SessionError::ActiveTakeExists));
        }
        self.ensure_session_ready()?;
        let at_ns = take_ms_to_ns(at_ms)?;
        let take_index = self.next_take_index;
        let take_id = TakeId::new(format!("take-{take_index}"));
        let session_id = self.session.session_id.clone();
        let score_fingerprint = self.session.score_fingerprint.clone();
        let profile_snapshot_id = self.session.profile_snapshot_id.clone();
        self.epoch_seq += 1;
        let epoch = self.epoch_seq;

        let mut take = PerformanceTake::new(
            take_id.clone(),
            session_id.clone(),
            take_index,
            score_fingerprint,
            profile_snapshot_id,
        );
        let version = take.state_version;
        take.apply_command(CommandEnvelope {
            command_id: self.next_command("take-prepare"),
            expected_state_version: version,
            command: TakeCommand::Prepare,
        })
        .map_err(napi_error)?;
        let version = take.state_version;
        take.apply_command(CommandEnvelope {
            command_id: self.next_command("take-ready"),
            expected_state_version: version,
            command: TakeCommand::MarkReady,
        })
        .map_err(napi_error)?;
        let version = take.state_version;
        take.apply_command(CommandEnvelope {
            command_id: self.next_command("take-start"),
            expected_state_version: version,
            command: TakeCommand::StartRecording { capture_epoch: epoch, at_ns },
        })
        .map_err(napi_error)?;

        self.session.register_take(&take).map_err(napi_error)?;
        self.router.begin_take(take_id.clone(), epoch, at_ns).map_err(napi_error)?;
        self.takes.insert(take_id.clone(), take);
        self.next_take_index += 1;

        Ok(JsTakeStart {
            practice_session_id: session_id.0,
            take_id: take_id.0,
            capture_epoch: epoch as f64,
            take_index,
            state: "recording".to_string(),
        })
    }

    fn apply_take_command(
        &mut self,
        take_id: &str,
        command: TakeCommand,
    ) -> napi::Result<TransitionReceipt> {
        let command_id = self.next_command("take");
        let take = self
            .takes
            .get_mut(&TakeId::new(take_id))
            .ok_or_else(|| napi_error(SessionError::TakeNotFound))?;
        let expected_state_version = take.state_version;
        take.apply_command(CommandEnvelope {
            command_id,
            expected_state_version,
            command,
        })
        .map_err(napi_error)
    }

    fn take_epoch(&self, take_id: &str) -> napi::Result<u64> {
        self.takes
            .get(&TakeId::new(take_id))
            .and_then(|take| take.capture_epoch)
            .ok_or_else(|| napi_error(SessionError::NoActiveCapture))
    }

    #[napi]
    pub fn pause(&mut self, take_id: String, at_ms: f64) -> napi::Result<()> {
        let at_ns = take_ms_to_ns(at_ms)?;
        self.apply_take_command(&take_id, TakeCommand::Pause { at_ns })?;
        Ok(())
    }

    #[napi]
    pub fn resume(&mut self, take_id: String, at_ms: f64) -> napi::Result<()> {
        let at_ns = take_ms_to_ns(at_ms)?;
        self.apply_take_command(&take_id, TakeCommand::Resume { at_ns })?;
        Ok(())
    }

    #[napi]
    pub fn stop(&mut self, take_id: String, at_ms: f64) -> napi::Result<()> {
        let at_ns = take_ms_to_ns(at_ms)?;
        let epoch = self.take_epoch(&take_id)?;
        self.apply_take_command(&take_id, TakeCommand::Stop { at_ns })?;
        self.router.stop_take(epoch, at_ns).map_err(napi_error)?;
        Ok(())
    }

    fn release_take(&mut self, take_id: &str) -> napi::Result<()> {
        let take = self
            .takes
            .get(&TakeId::new(take_id))
            .ok_or_else(|| napi_error(SessionError::TakeNotFound))?;
        self.session.release_take(take).map_err(napi_error)
    }

    #[napi(js_name = "finalizeSucceeded")]
    pub fn finalize_succeeded(&mut self, take_id: String) -> napi::Result<()> {
        let epoch = self.take_epoch(&take_id)?;
        self.apply_take_command(&take_id, TakeCommand::FinalizeSucceeded)?;
        self.router.seal_take(epoch).map_err(napi_error)?;
        self.release_take(&take_id)
    }

    #[napi(js_name = "finalizeFailed")]
    pub fn finalize_failed(&mut self, take_id: String, reason: String) -> napi::Result<()> {
        let epoch = self.take_epoch(&take_id)?;
        self.apply_take_command(&take_id, TakeCommand::FinalizeFailed { reason })?;
        let _ = self.router.seal_take(epoch);
        self.release_take(&take_id)
    }

    #[napi]
    pub fn abort(&mut self, take_id: String, at_ms: f64, reason: String) -> napi::Result<()> {
        let at_ns = take_ms_to_ns(at_ms)?;
        let epoch = self.take_epoch(&take_id)?;
        self.apply_take_command(&take_id, TakeCommand::Abort { reason, at_ns })?;
        let _ = self.router.stop_take(epoch, at_ns);
        let _ = self.router.seal_take(epoch);
        self.release_take(&take_id)
    }

    /// Unrecoverable per-take error (invalid input, engine clock violation).
    /// Distinct from Abort: the take lands in Failed and keeps its trace.
    #[napi]
    pub fn fail(&mut self, take_id: String, at_ms: f64, reason: String) -> napi::Result<()> {
        let at_ns = take_ms_to_ns(at_ms)?;
        let epoch = self.take_epoch(&take_id)?;
        self.apply_take_command(&take_id, TakeCommand::Fail { reason, at_ns })?;
        let _ = self.router.stop_take(epoch, at_ns);
        let _ = self.router.seal_take(epoch);
        self.release_take(&take_id)
    }

    /// Orthogonal input-health update ("unknown"|"healthy"|"degraded"|"disconnected").
    /// Health never changes lifecycle state; it must be visible in the report.
    #[napi(js_name = "setInputHealth")]
    pub fn set_input_health(&mut self, take_id: String, health: String) -> napi::Result<()> {
        let parsed = match health.as_str() {
            "unknown" => rhythm_core::take::InputHealth::Unknown,
            "healthy" => rhythm_core::take::InputHealth::Healthy,
            "degraded" => rhythm_core::take::InputHealth::Degraded,
            "disconnected" => rhythm_core::take::InputHealth::Disconnected,
            other => return Err(napi_error(format!("unknown input health `{other}`"))),
        };
        let take = self
            .takes
            .get_mut(&TakeId::new(take_id))
            .ok_or_else(|| napi_error(SessionError::TakeNotFound))?;
        take.set_input_health(parsed);
        Ok(())
    }

    #[napi(js_name = "routePacket")]
    pub fn route_packet(
        &mut self,
        capture_epoch: f64,
        source_id: String,
        source_seq: f64,
        at_ms: f64,
    ) -> napi::Result<JsRoutingDecision> {
        let epoch = to_u64(capture_epoch, "captureEpoch")?;
        let sequence = to_u64(source_seq, "sourceSeq")?;
        let received_at_ns = take_ms_to_ns(at_ms)?;
        self.event_seq += 1;
        let packet = StampedMidiPacket {
            event_id: EventId::new(format!("event-{}", self.event_seq)),
            source_id: SourceId::new(source_id),
            capture_epoch: epoch,
            source_sequence: sequence,
            received_at_ns,
            payload: TakeMidiEventKind::Other { status: 0, data1: 0, data2: 0 },
        };
        let decision = self.router.route(packet);
        let kind = decision.kind().to_string();
        let (accepted, take_id, expected_epoch) = match &decision {
            rhythm_core::take::EventRoutingDecision::AcceptedForTake { take_id, .. } => {
                (true, take_id.0.clone(), 0.0)
            }
            rhythm_core::take::EventRoutingDecision::QuarantinedEpochMismatch { expected, .. } => {
                (false, String::new(), *expected as f64)
            }
            _ => (false, String::new(), 0.0),
        };
        Ok(JsRoutingDecision { accepted, kind, take_id, expected_epoch })
    }

    #[napi]
    pub fn snapshot(&self) -> JsTakeSnapshot {
        let active = self
            .session
            .active_take_id
            .as_ref()
            .and_then(|take_id| self.takes.get(take_id));
        let stats = self.router.stats();
        JsTakeSnapshot {
            practice_session_id: self.session.session_id.0.clone(),
            session_state: self.session.state.as_str().to_string(),
            session_version: self.session.state_version as f64,
            active_take_id: active.map(|take| take.take_id.0.clone()).unwrap_or_default(),
            take_count: self.session.take_ids.len() as u32,
            take_id: active.map(|take| take.take_id.0.clone()).unwrap_or_default(),
            take_state: active.map(|take| take.state.as_str().to_string()).unwrap_or_else(|| "none".to_string()),
            take_version: active.map(|take| take.state_version as f64).unwrap_or(0.0),
            capture_epoch: active.and_then(|take| take.capture_epoch).unwrap_or(0) as f64,
            capture_started_at_ms: active
                .and_then(|take| take.capture_started_at_ns)
                .map(|ns| ns as f64 / 1_000_000.0)
                .unwrap_or(0.0),
            capture_ended_at_ms: active
                .and_then(|take| take.capture_ended_at_ns)
                .map(|ns| ns as f64 / 1_000_000.0)
                .unwrap_or(0.0),
            input_health: active.map(|take| take.input_health.as_str().to_string()).unwrap_or_else(|| "unknown".to_string()),
            finalization_status: active
                .map(|take| take.finalization_status.as_str().to_string())
                .unwrap_or_else(|| "not_started".to_string()),
            report_revision: active.map(|take| take.report_revision as f64).unwrap_or(0.0),
            accepted_packets: stats.accepted as f64,
            quarantined_packets: stats.quarantined_total() as f64,
            epoch_mismatch: stats.epoch_mismatch as f64,
            sequence_regression: stats.sequence_regression as f64,
            after_capture_stop: stats.after_capture_stop as f64,
        }
    }

    #[napi(js_name = "sessionId")]
    pub fn session_id(&self) -> String {
        self.session.session_id.0.clone()
    }
}

// Version constants surfaced for report traceability. Re-exported rather than
// duplicated so the report and the core can never drift apart.
#[napi]
pub fn scoring_algorithm_version() -> String {
    rhythm_core::SCORING_ALGORITHM_VERSION.to_string()
}

#[napi]
pub fn midi_contract_algorithm_version() -> String {
    rhythm_core::MIDI_CONTRACT_ALGORITHM_VERSION.to_string()
}

// ---------------------------------------------------------------------------
// B1: full final-score contract. The scoring algorithm remains in
// rhythm-core::scoring_v1; this layer only maps the existing inputs/outputs.

#[napi(object)]
pub struct JsScoreEventInput {
    pub score_event_id: String,
    pub measure: u32,
    /// Quarter-note beat position from the playback origin (including count-in
    /// if the caller wants that representation; scoring uses onset ms).
    pub beat_position: f64,
    pub pitch: u32,
    pub target_onset_ms: f64,
    pub target_duration_ms: f64,
    pub part_id: Option<String>,
    pub parse_confidence: Option<f64>,
}

#[napi(object)]
pub struct JsPerformedNoteInput {
    pub performed_note_id: String,
    pub pitch: u32,
    pub onset_ms: f64,
    pub release_ms: Option<f64>,
    /// "complete" | "missing-release" | "ambiguous" | "invalid-time"
    pub pairing_status: String,
}

#[napi(object)]
pub struct JsAlignmentPairOutput {
    pub score_event_id: String,
    pub performed_note_id: String,
    pub pitch_matched: bool,
    pub onset_error_ms: f64,
    pub measure: u32,
    pub pairing_status: Option<String>,
}

#[napi(object)]
pub struct JsScoreEventResult {
    /// "MATCH" | "WRONG_PITCH" | "MISSING" | "EXTRA" | "AMBIGUOUS"
    pub result: String,
    pub score_event_id: Option<String>,
    pub performed_note_id: Option<String>,
    pub measure: Option<u32>,
    pub expected_pitch: Option<u32>,
    pub actual_pitch: Option<u32>,
    pub onset_error_ms: Option<f64>,
    pub pairing_status: Option<String>,
    pub reason: Option<String>,
}

#[napi(object)]
pub struct JsPitchAccuracy {
    pub targets: u32,
    pub correct: u32,
    pub wrong_pitch: u32,
    pub missed: u32,
    pub extra: u32,
    pub recall: Option<f64>,
    pub precision: Option<f64>,
}

#[napi(object)]
pub struct JsOnsetMetrics {
    pub matched: u32,
    pub signed_mean_ms: Option<f64>,
    pub signed_median_ms: Option<f64>,
    pub mean_absolute_ms: Option<f64>,
    pub p50_absolute_ms: Option<f64>,
    pub p90_absolute_ms: Option<f64>,
    pub out_of_tolerance_count: u32,
    pub out_of_tolerance_ratio: Option<f64>,
}

#[napi(object)]
pub struct JsRhythmMetrics {
    pub interval_samples: u32,
    pub mean_speed_ratio: Option<f64>,
    pub jitter_ratio_mad: Option<f64>,
    pub drift_ratio_slope_per_index: Option<f64>,
    pub rhythm_compensation_suspected: bool,
}

#[napi(object)]
pub struct JsScoreDurationMetrics {
    pub graded: u32,
    pub mean_ratio: Option<f64>,
    pub too_short_count: u32,
    pub too_long_count: u32,
}

#[napi(object)]
pub struct JsContinuityMetrics {
    pub covered_ratio: Option<f64>,
    pub longest_matched_streak: u32,
    pub measures_total: u32,
    pub measures_with_any_match: u32,
}

#[napi(object)]
pub struct JsMeasureReport {
    pub measure: u32,
    pub matched: u32,
    pub missed: u32,
    pub mean_abs_onset_error_ms: Option<f64>,
    pub mean_speed_ratio: Option<f64>,
}

#[napi(object)]
pub struct JsSubScore {
    pub name: String,
    pub score: Option<f64>,
    pub weight: f64,
    pub sample_count: u32,
}

#[napi(object)]
pub struct JsOverallScore {
    pub score: Option<f64>,
    pub subscores: Vec<JsSubScore>,
    pub renormalized: bool,
}

#[napi(object)]
pub struct JsScoringDiagnostic {
    pub category: String,
    pub severity: String,
    pub measure_start: Option<u32>,
    pub measure_end: Option<u32>,
    pub evidence: String,
    pub confidence: String,
    pub suggested_action: String,
    pub score_event_ids: Vec<String>,
    pub performed_event_ids: Vec<String>,
}

#[napi(object)]
pub struct JsPracticeRange {
    pub start_measure: u32,
    pub end_measure: u32,
    pub reason: String,
    pub priority: u32,
}

#[napi(object)]
pub struct JsSessionScoreReport {
    pub algorithm_version: String,
    pub config_version: String,
    pub alignment_pairs: Vec<JsAlignmentPairOutput>,
    pub missed_score_event_ids: Vec<String>,
    pub extra_performed_ids: Vec<String>,
    pub rest_window_extra_ids: Vec<String>,
    pub event_results: Vec<JsScoreEventResult>,
    pub pitch: JsPitchAccuracy,
    pub onset: JsOnsetMetrics,
    pub rhythm: JsRhythmMetrics,
    pub duration: JsScoreDurationMetrics,
    pub continuity: JsContinuityMetrics,
    pub measures: Vec<JsMeasureReport>,
    pub overall: JsOverallScore,
    pub confidence: String,
    pub data_degraded: bool,
    pub diagnostics: Vec<JsScoringDiagnostic>,
    pub practice_ranges: Vec<JsPracticeRange>,
}

fn to_core_score_event(event: JsScoreEventInput) -> napi::Result<rhythm_core::ScoreEvent> {
    if event.pitch > 127 {
        return Err(napi_error("score event pitch must be within 0..=127"));
    }
    if event.measure == 0 {
        return Err(napi_error("score event measure must be >= 1"));
    }
    if !event.beat_position.is_finite() || !event.target_onset_ms.is_finite()
        || !event.target_duration_ms.is_finite() || event.target_onset_ms < 0.0
        || event.target_duration_ms <= 0.0 {
        return Err(napi_error("score event times must be finite and valid"));
    }
    Ok(rhythm_core::ScoreEvent {
        score_event_id: event.score_event_id,
        measure: event.measure,
        beat_position: event.beat_position,
        pitch: event.pitch as u8,
        target_onset_ms: event.target_onset_ms,
        target_duration_ms: event.target_duration_ms,
        part_id: event.part_id.unwrap_or_default(),
        parse_confidence: event.parse_confidence.unwrap_or(1.0) as f32,
    })
}

fn to_core_performed_note(note: JsPerformedNoteInput) -> napi::Result<rhythm_core::PerformedNoteV1> {
    if note.pitch > 127 {
        return Err(napi_error("performed pitch must be within 0..=127"));
    }
    if !note.onset_ms.is_finite() || note.onset_ms < 0.0 {
        return Err(napi_error("performed onset must be finite and >= 0"));
    }
    if note.release_ms.is_some_and(|value| !value.is_finite() || value < note.onset_ms) {
        return Err(napi_error("performed release must be finite and >= onset"));
    }
    let pairing_status = match note.pairing_status.as_str() {
        "complete" => rhythm_core::PairingStatusV1::Complete,
        "missing-release" | "missing-note-off" | "interrupted-by-disconnect" => rhythm_core::PairingStatusV1::MissingRelease,
        "ambiguous" | "ambiguous-pairing" => rhythm_core::PairingStatusV1::Ambiguous,
        "invalid-time" => rhythm_core::PairingStatusV1::InvalidTime,
        other => return Err(napi_error(format!("unknown pairing status `{other}`"))),
    };
    Ok(rhythm_core::PerformedNoteV1 {
        performed_note_id: note.performed_note_id,
        pitch: note.pitch as u8,
        onset_ms: note.onset_ms,
        release_ms: note.release_ms,
        pairing_status,
    })
}

/// Scores a finalized performance using the existing rhythm-core scoring_v1
/// implementation. Returns the complete report, including event-level results
/// derived from the existing alignment (no second scoring algorithm).
#[napi(js_name = "scorePerformance")]
pub fn js_score_performance(
    score_events: Vec<JsScoreEventInput>,
    performed: Vec<JsPerformedNoteInput>,
) -> napi::Result<JsSessionScoreReport> {
    let core_score_events = score_events.into_iter().map(to_core_score_event).collect::<napi::Result<Vec<_>>>()?;
    let core_performed = performed.into_iter().map(to_core_performed_note).collect::<napi::Result<Vec<_>>>()?;
    let report = rhythm_core::score_performance(
        &core_score_events,
        &core_performed,
        &rhythm_core::ScoringConfig::default(),
    ).map_err(napi_error)?;

    let score_by_id: std::collections::BTreeMap<&str, &rhythm_core::ScoreEvent> = core_score_events
        .iter().map(|event| (event.score_event_id.as_str(), event)).collect();
    let performed_by_id: std::collections::BTreeMap<&str, &rhythm_core::PerformedNoteV1> = core_performed
        .iter().map(|note| (note.performed_note_id.as_str(), note)).collect();
    let pairing_label = |status: rhythm_core::PairingStatusV1| -> &'static str {
        match status {
            rhythm_core::PairingStatusV1::Complete => "complete",
            rhythm_core::PairingStatusV1::MissingRelease => "missing-release",
            rhythm_core::PairingStatusV1::Ambiguous => "ambiguous",
            rhythm_core::PairingStatusV1::InvalidTime => "invalid-time",
        }
    };

    let mut pairs = Vec::with_capacity(report.alignment.pairs.len());
    let mut event_results = Vec::new();
    for pair in &report.alignment.pairs {
        let performed_note = performed_by_id.get(pair.performed_note_id.as_str()).copied();
        let status = performed_note.map(|note| note.pairing_status);
        let pairing_status = status.map(pairing_label).map(str::to_string);
        pairs.push(JsAlignmentPairOutput {
            score_event_id: pair.score_event_id.clone(),
            performed_note_id: pair.performed_note_id.clone(),
            pitch_matched: pair.pitch_matched,
            onset_error_ms: pair.onset_error_ms,
            measure: pair.measure,
            pairing_status: pairing_status.clone(),
        });
        let target = score_by_id.get(pair.score_event_id.as_str()).copied();
        let performed_note = performed_by_id.get(pair.performed_note_id.as_str()).copied();
        let ambiguous = status.is_some_and(|value| matches!(value, rhythm_core::PairingStatusV1::Ambiguous));
        event_results.push(JsScoreEventResult {
            result: if ambiguous {
                "AMBIGUOUS".to_string()
            } else if pair.pitch_matched {
                "MATCH".to_string()
            } else {
                "WRONG_PITCH".to_string()
            },
            score_event_id: Some(pair.score_event_id.clone()),
            performed_note_id: Some(pair.performed_note_id.clone()),
            measure: Some(pair.measure),
            expected_pitch: target.map(|event| event.pitch as u32),
            actual_pitch: performed_note.map(|note| note.pitch as u32),
            onset_error_ms: Some(pair.onset_error_ms),
            pairing_status,
            reason: Some(if ambiguous {
                "ambiguous_pairing".to_string()
            } else if pair.pitch_matched {
                "matched".to_string()
            } else {
                "pitch_mismatch".to_string()
            }),
        });
    }
    for score_event_id in &report.alignment.missed_score_event_ids {
        let target = score_by_id.get(score_event_id.as_str()).copied();
        event_results.push(JsScoreEventResult {
            result: "MISSING".to_string(),
            score_event_id: Some(score_event_id.clone()),
            performed_note_id: None,
            measure: target.map(|event| event.measure),
            expected_pitch: target.map(|event| event.pitch as u32),
            actual_pitch: None,
            onset_error_ms: None,
            pairing_status: None,
            reason: Some("no_performed_note".to_string()),
        });
    }
    for performed_note_id in &report.alignment.extra_performed_ids {
        let performed_note = performed_by_id.get(performed_note_id.as_str()).copied();
        event_results.push(JsScoreEventResult {
            result: "EXTRA".to_string(),
            score_event_id: None,
            performed_note_id: Some(performed_note_id.clone()),
            measure: None,
            expected_pitch: None,
            actual_pitch: performed_note.map(|note| note.pitch as u32),
            onset_error_ms: None,
            pairing_status: performed_note.map(|note| pairing_label(note.pairing_status).to_string()),
            reason: Some("unmatched_extra".to_string()),
        });
    }

    let overall = JsOverallScore {
        score: report.overall.score,
        renormalized: report.overall.renormalized,
        subscores: report.overall.subscores.iter().map(|sub| JsSubScore {
            name: sub.name.to_string(),
            score: sub.score,
            weight: sub.weight,
            sample_count: sub.sample_count as u32,
        }).collect(),
    };
    let diagnostics = report.diagnostics.iter().map(|diagnostic| JsScoringDiagnostic {
        category: diagnostic.category.to_string(),
        severity: diagnostic.severity.to_string(),
        measure_start: diagnostic.measure_range.map(|value| value.0),
        measure_end: diagnostic.measure_range.map(|value| value.1),
        evidence: diagnostic.evidence.clone(),
        confidence: diagnostic.confidence.as_str().to_string(),
        suggested_action: diagnostic.suggested_action.clone(),
        score_event_ids: diagnostic.score_event_ids.clone(),
        performed_event_ids: diagnostic.performed_event_ids.clone(),
    }).collect();
    let practice_ranges = report.practice_ranges.iter().map(|range| JsPracticeRange {
        start_measure: range.start_measure,
        end_measure: range.end_measure,
        reason: range.reason.clone(),
        priority: range.priority as u32,
    }).collect();

    Ok(JsSessionScoreReport {
        algorithm_version: report.algorithm_version,
        config_version: format!("{}:default", rhythm_core::SCORING_ALGORITHM_VERSION),
        alignment_pairs: pairs,
        missed_score_event_ids: report.alignment.missed_score_event_ids,
        extra_performed_ids: report.alignment.extra_performed_ids,
        rest_window_extra_ids: report.alignment.rest_window_extra_ids,
        event_results,
        pitch: JsPitchAccuracy {
            targets: report.pitch.targets as u32,
            correct: report.pitch.correct as u32,
            wrong_pitch: report.pitch.wrong_pitch as u32,
            missed: report.pitch.missed as u32,
            extra: report.pitch.extra as u32,
            recall: report.pitch.recall,
            precision: report.pitch.precision,
        },
        onset: JsOnsetMetrics {
            matched: report.onset.matched as u32,
            signed_mean_ms: report.onset.signed_mean_ms,
            signed_median_ms: report.onset.signed_median_ms,
            mean_absolute_ms: report.onset.mean_absolute_ms,
            p50_absolute_ms: report.onset.p50_absolute_ms,
            p90_absolute_ms: report.onset.p90_absolute_ms,
            out_of_tolerance_count: report.onset.out_of_tolerance_count as u32,
            out_of_tolerance_ratio: report.onset.out_of_tolerance_ratio,
        },
        rhythm: JsRhythmMetrics {
            interval_samples: report.rhythm.interval_samples as u32,
            mean_speed_ratio: report.rhythm.mean_speed_ratio,
            jitter_ratio_mad: report.rhythm.jitter_ratio_mad,
            drift_ratio_slope_per_index: report.rhythm.drift_ratio_slope_per_index,
            rhythm_compensation_suspected: report.rhythm.rhythm_compensation_suspected,
        },
        duration: JsScoreDurationMetrics {
            graded: report.duration.graded as u32,
            mean_ratio: report.duration.mean_ratio,
            too_short_count: report.duration.too_short_count as u32,
            too_long_count: report.duration.too_long_count as u32,
        },
        continuity: JsContinuityMetrics {
            covered_ratio: report.continuity.covered_ratio,
            longest_matched_streak: report.continuity.longest_matched_streak as u32,
            measures_total: report.continuity.measures_total as u32,
            measures_with_any_match: report.continuity.measures_with_any_match as u32,
        },
        measures: report.measures.iter().map(|measure| JsMeasureReport {
            measure: measure.measure,
            matched: measure.matched as u32,
            missed: measure.missed as u32,
            mean_abs_onset_error_ms: measure.mean_abs_onset_error_ms,
            mean_speed_ratio: measure.mean_speed_ratio,
        }).collect(),
        overall,
        confidence: report.confidence.as_str().to_string(),
        data_degraded: report.data_degraded,
        diagnostics,
        practice_ranges,
    })
}

// ---------------------------------------------------------------------------
// R2-3c: contract_v1 planner dual-run surface (JSON-in / JSON-out; the JSON
// integers pass through untouched — task card C-4). These exports are ADDITIVE
// to the production surface above; no existing export changes behavior.
// Errors surface as `"<CODE>: <message>"` (ContractError Display), so the
// harness can match frozen error codes.
// ---------------------------------------------------------------------------

fn parse_json(text: &str, field: &str) -> napi::Result<serde_json::Value> {
    // Malformed input JSON is a contract rejection too — it must carry the
    // frozen code prefix, never an opaque message (review requirement:
    // rejections stay code-identifiable across the Node boundary).
    serde_json::from_str(text)
        .map_err(|error| napi_error(format!("SCHEMA_VIOLATION: {field} is not valid JSON: {error}")))
}

fn contract_result(value: Result<serde_json::Value, rhythm_core::contract_v1::ContractError>) -> napi::Result<String> {
    value.map(|value| value.to_string()).map_err(|error| napi_error(error.to_string()))
}

/// Builds the PlannerOutput (task card §2.3) from the frozen ScoreDocumentV1,
/// ImportReportV1 and parity-case config JSON instances.
#[napi]
pub fn build_plan_v1(document_json: String, report_json: String, config_json: String) -> napi::Result<String> {
    let document = parse_json(&document_json, "document")?;
    let report = parse_json(&report_json, "report")?;
    let config = parse_json(&config_json, "config")?;
    contract_result(rhythm_core::contract_v1::build_plan_v1(&document, &report, &config))
}

/// Builds the frozen ParityCandidate projection ({ candidate, meta }) that
/// feeds the TS `diffCandidates` comparator in the dual-run harness.
#[napi]
pub fn build_parity_candidate_v1(document_json: String, report_json: String, config_json: String) -> napi::Result<String> {
    let document = parse_json(&document_json, "document")?;
    let report = parse_json(&report_json, "report")?;
    let config = parse_json(&config_json, "config")?;
    contract_result(rhythm_core::contract_v1::build_parity_candidate_v1(&document, &report, &config))
}

/// The mandatory a3 fingerprint gate over a PlannerOutput.
#[napi]
pub fn plan_fingerprint_v1_gate(
    document_json: String,
    report_json: String,
    plan_json: String,
    config_json: String,
) -> napi::Result<String> {
    let document = parse_json(&document_json, "document")?;
    let report = parse_json(&report_json, "report")?;
    let plan = parse_json(&plan_json, "plan")?;
    let config = parse_json(&config_json, "config")?;
    rhythm_core::contract_v1::plan_fingerprint_v1_gate(&document, &report, &plan, &config)
        .map(|fingerprint| fingerprint)
        .map_err(|error| napi_error(error.to_string()))
}

/// E4-V channel: recomputes a committed fingerprint vector payload with the
/// independent Rust primitive (NFC/JCS/SHA-256 in-tree; no FFI to TS).
/// Rejections carry the frozen contract code prefix.
#[napi]
pub fn compute_plan_fingerprint_v1_json(payload_json: String) -> napi::Result<String> {
    let mut payload = parse_json(&payload_json, "payload")?;
    rhythm_core::contract_v1::compute_plan_fingerprint_v1(&mut payload)
        .map(|fingerprint| fingerprint)
        .map_err(|error| napi_error(error.to_string()))
}

/// E4-V channel: canonical JSON bytes (RFC 8785 over NFC) of a vector payload.
#[napi]
pub fn canonical_bytes_json(payload_json: String) -> napi::Result<String> {
    let mut payload = parse_json(&payload_json, "payload")?;
    rhythm_core::contract_v1::canonical_bytes(&mut payload)
        .map(|bytes| bytes)
        .map_err(|error| napi_error(error.to_string()))
}

/// E4-C channel: the Rust-side candidate-output validator emitting the four
/// frozen normative codes; executed live by the R2-3d evidence harness.
/// Returns the code, or null when the candidate is acceptable. Malformed
/// (non-array) payloads are REJECTED, never read as "no violation".
#[napi]
pub fn validate_candidate_score_events_json(
    events_json: String,
    atom_bars: Option<Vec<f64>>,
    prescription_range: Option<Vec<f64>>,
) -> napi::Result<Option<String>> {
    let events = parse_json(&events_json, "events")?;
    let options = rhythm_core::contract_v1::CandidateValidationOptions {
        atom_bars,
        prescription_range: prescription_range.map(|range| (range[0], range[1])),
    };
    Ok(rhythm_core::contract_v1::validate_candidate_score_events(&events, &options).map(String::from))
}

/// R2-3g channel: the frozen time-conversion primitive (integer µs from a
/// reduced rational beat + reduced rational BPM), exposed for the planner
/// service's scoreEvents↔groups time-consistency checks.
#[napi]
pub fn beat_to_microseconds_json(beat_json: String, bpm_json: String) -> napi::Result<i64> {
    use rhythm_core::contract_v1::RationalV1;
    let parse = |text: &str, field: &str| -> napi::Result<RationalV1> {
        let value = parse_json(text, field)?;
        Ok(RationalV1 {
            numerator: value.get("numerator").and_then(|v| v.as_i64())
                .ok_or_else(|| napi_error(format!("{field}.numerator missing")))?,
            denominator: value.get("denominator").and_then(|v| v.as_i64())
                .ok_or_else(|| napi_error(format!("{field}.denominator missing")))?,
        })
    };
    let beat = parse(&beat_json, "beat")?;
    let bpm = parse(&bpm_json, "bpm")?;
    rhythm_core::contract_v1::beat_to_microseconds(&beat, &bpm)
        .map_err(|error| napi_error(error.to_string()))
}
