//! Deterministic rhythm-training core. No Node, browser, MIDI, audio, or UI dependencies.

pub mod contract_v1;
mod duration;
mod error;
mod events;
pub mod follow;
mod matcher;
mod midi;
mod replay;
mod alignment_candidate;
pub mod alignment_dp_v2;
mod scoring_v1;
mod ring_buffer;
mod schedule;
mod session;
mod stats;
pub mod take;
mod teaching;

pub use duration::{
    assess_durations, assess_presses, assess_presses_with_pauses, pair_note_events, DurationAssessment, DurationPolicy, DurationPolicyKind,
    DurationReport, DurationResult, NoteEventQuality, PerformedNote, RawMidiNoteEvent, RawNoteKind,
};
pub use error::CoreError;
pub use events::{Grade, InputSource, Judgment, StrikeEvent};
pub use midi::{
    decode_ingest_packet, track_key_lifecycles, ClockQuality, DecodedMidiEvent, IngestMidiPacket,
    KeyLifecycleReport, KeyLifecycleTracker, KeyPressObservation, KeyPressStatus, MidiDiagnostic,
    MidiEventKind, MidiEventOriginalEncoding, MidiTransport, RawMidiPacket,
    MIDI_CONTRACT_ALGORITHM_VERSION,
};
pub use matcher::HitMatcher;
pub use replay::{replay_score, ReplayResult};
pub use ring_buffer::RingBuffer;
pub use schedule::{apply_judgment_windows, build_schedule, AtomKind, JudgmentProfile, RhythmAtom, RhythmPattern, TargetHit};
pub use alignment_candidate::{
    align_performances_candidate, LATE_WINDOW_INTERVAL_RATIO, MAX_LATE_WINDOW_MS,
};
pub use alignment_dp_v2::{
    align_performances_dp_v2, to_legacy_alignment, validate_alignment_result_v2, AlignmentDpConfigV1,
    AlignmentDiagnosticV2, AlignmentKind, AlignmentPairV2, AlignmentResultV2, AlignmentStatusV2,
    AmbiguousGroupV2, ALIGNMENT_DP_V2_ALGORITHM_VERSION, ALIGNMENT_RESOURCE_LIMIT,
    LATE_BUT_PAIRED_BEYOND_LEGACY_WINDOW, SAME_PITCH_ASSIGNMENT_AMBIGUOUS,
};
pub use scoring_v1::{
    align_performances, align_performances_traced, score_performance, score_performance_candidate, score_performance_dp_v2,
    AlignmentBranch,
    AlignmentPair, AlignmentResult, AlignmentStep, Confidence,
    Diagnostic as ScoringDiagnostic,
    MeasureReport, OverallScore, PairingStatusV1, PerformedNoteV1, PitchAccuracy, PracticeProfileV1,
    PracticeRange, RhythmMetrics, ScoreEvent, ScoringConfig, SessionScoreReport, SubScore,
    TracedAlignment, SCORING_ALGORITHM_VERSION, SCORING_CANDIDATE_ALGORITHM_VERSION, SCORING_DP_V2_ALGORITHM_VERSION,
};
pub use session::{EngineDiagnostics, SessionEngine, SessionReport, SessionState};
pub use stats::{calculate_stats, ScoreStats};

pub use teaching::{
    diagnose_timing, extract_timing_features, recommend_exercise, DiagnosticContext,
    DiagnosisReport, Diagnostic, DiagnosisThresholds, EvidenceConfidence, ExerciseKind,
    ExercisePrescription, MasteryAttempt, MasteryPolicy, MasteryState, MetronomeMode,
    SkillProgress, Severity, StudentModel, TimingFeatures, TimingIssue,
};
