//! Initial, standard-library-only model for Rhythm Trainer session lifecycle.
//!
//! This crate is a reference model and contract starter, not the complete
//! product engine. Adapt names and serialization to the host repository after
//! auditing its current architecture.

use std::collections::HashMap;
use std::fmt;

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(pub String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}

string_id!(PracticeSessionId);
string_id!(TakeId);
string_id!(CommandId);
string_id!(SourceId);
string_id!(PlaybackOccurrenceId);
string_id!(ScoreFingerprint);
string_id!(ProfileSnapshotId);
string_id!(EventId);

/// Monotonic process/session time in nanoseconds. Do not use wall-clock time
/// for elapsed-time metrics. The owner of this type must ensure one clock base.
pub type MonotonicNs = u64;
pub type CaptureEpoch = u64;
pub type EventSequence = u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RationalBeat {
    pub numerator: i64,
    pub denominator: u32,
}

impl RationalBeat {
    pub fn new(numerator: i64, denominator: u32) -> Result<Self, SessionError> {
        if denominator == 0 {
            return Err(SessionError::InvalidBeatDenominator);
        }
        let mut a = numerator.unsigned_abs();
        let mut b = u64::from(denominator);
        while b != 0 {
            let remainder = a % b;
            a = b;
            b = remainder;
        }
        let gcd = a.max(1) as u32;
        Ok(Self {
            numerator: numerator / i64::from(gcd),
            denominator: denominator / gcd,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PracticeSessionState {
    Draft,
    Preparing,
    Ready,
    Active,
    Reviewing,
    Completed,
    Aborted,
    Failed,
}

impl PracticeSessionState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Aborted | Self::Failed)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Preparing => "preparing",
            Self::Ready => "ready",
            Self::Active => "active",
            Self::Reviewing => "reviewing",
            Self::Completed => "completed",
            Self::Aborted => "aborted",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TakeState {
    Created,
    Preparing,
    Ready,
    Countdown,
    Recording,
    Paused,
    Finalizing,
    Completed,
    Aborted,
    Failed,
}

impl TakeState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Aborted | Self::Failed)
    }

    pub fn accepts_scoreable_input(self) -> bool {
        self == Self::Recording
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Preparing => "preparing",
            Self::Ready => "ready",
            Self::Countdown => "countdown",
            Self::Recording => "recording",
            Self::Paused => "paused",
            Self::Finalizing => "finalizing",
            Self::Completed => "completed",
            Self::Aborted => "aborted",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputHealth {
    Unknown,
    Healthy,
    Degraded,
    Disconnected,
}

impl InputHealth {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Healthy => "healthy",
            Self::Degraded => "degraded",
            Self::Disconnected => "disconnected",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FinalizationStatus {
    NotStarted,
    Running,
    Succeeded,
    Failed,
}

impl FinalizationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotStarted => "not_started",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TakeCommand {
    Prepare,
    MarkReady,
    StartCountdown,
    StartRecording { capture_epoch: CaptureEpoch, at_ns: MonotonicNs },
    Pause { at_ns: MonotonicNs },
    Resume { at_ns: MonotonicNs },
    Stop { at_ns: MonotonicNs },
    FinalizeSucceeded,
    FinalizeFailed { reason: String },
    Abort { reason: String, at_ns: MonotonicNs },
    Fail { reason: String, at_ns: MonotonicNs },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandEnvelope {
    pub command_id: CommandId,
    pub expected_state_version: u64,
    pub command: TakeCommand,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransitionReceipt {
    pub command_id: CommandId,
    pub previous_state: TakeState,
    pub current_state: TakeState,
    pub state_version: u64,
    pub duplicate: bool,
    pub effects: Vec<TakeEffect>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TakeEffect {
    FreezeProfileSnapshot,
    ActivateCaptureEpoch(CaptureEpoch),
    WritePauseBoundary(MonotonicNs),
    WriteResumeBoundary(MonotonicNs),
    CloseScoreableInputGate(MonotonicNs),
    DrainAndSealTrace,
    BeginFinalization,
    SealFinalReport,
    PreserveTraceAndReason(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionError {
    InvalidTransition { from: TakeState, command: &'static str },
    StaleStateVersion { expected: u64, actual: u64 },
    InvalidBeatDenominator,
    CaptureAlreadyActive,
    NoActiveCapture,
    EpochMismatch { expected: CaptureEpoch, received: CaptureEpoch },
    BeforeCaptureStart,
    AfterCaptureStop,
    SequenceRegression { previous: EventSequence, received: EventSequence },
    SessionTerminal,
    ActiveTakeExists,
    TakeNotFound,
    WrongTake,
    CursorTakeMismatch,
    CursorSequenceRegression,
    InvalidCursorConfidence,
    SessionCommandInvalid,
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for SessionError {}

#[derive(Clone, Debug)]
pub struct PerformanceTake {
    pub take_id: TakeId,
    pub session_id: PracticeSessionId,
    pub take_index: u32,
    pub state: TakeState,
    pub state_version: u64,
    pub capture_epoch: Option<CaptureEpoch>,
    pub capture_started_at_ns: Option<MonotonicNs>,
    pub capture_ended_at_ns: Option<MonotonicNs>,
    pub input_health: InputHealth,
    pub finalization_status: FinalizationStatus,
    pub finalization_attempt: u32,
    pub score_fingerprint: ScoreFingerprint,
    pub profile_snapshot_id: ProfileSnapshotId,
    pub report_revision: u32,
    command_receipts: HashMap<CommandId, TransitionReceipt>,
}

impl PerformanceTake {
    pub fn new(
        take_id: TakeId,
        session_id: PracticeSessionId,
        take_index: u32,
        score_fingerprint: ScoreFingerprint,
        profile_snapshot_id: ProfileSnapshotId,
    ) -> Self {
        Self {
            take_id,
            session_id,
            take_index,
            state: TakeState::Created,
            state_version: 0,
            capture_epoch: None,
            capture_started_at_ns: None,
            capture_ended_at_ns: None,
            input_health: InputHealth::Unknown,
            finalization_status: FinalizationStatus::NotStarted,
            finalization_attempt: 0,
            score_fingerprint,
            profile_snapshot_id,
            report_revision: 0,
            command_receipts: HashMap::new(),
        }
    }

    /// Apply a command through a serialized command processor.
    /// Duplicate command IDs return the original receipt and never replay effects.
    pub fn apply_command(
        &mut self,
        envelope: CommandEnvelope,
    ) -> Result<TransitionReceipt, SessionError> {
        if let Some(previous) = self.command_receipts.get(&envelope.command_id) {
            let mut receipt = previous.clone();
            receipt.duplicate = true;
            receipt.effects.clear();
            return Ok(receipt);
        }

        if envelope.expected_state_version != self.state_version {
            return Err(SessionError::StaleStateVersion {
                expected: envelope.expected_state_version,
                actual: self.state_version,
            });
        }

        let previous_state = self.state;
        let mut effects = Vec::new();
        let command_name = command_name(&envelope.command);
        let next_state = match (&self.state, &envelope.command) {
            (TakeState::Created, TakeCommand::Prepare) => {
                effects.push(TakeEffect::FreezeProfileSnapshot);
                TakeState::Preparing
            }
            (TakeState::Preparing, TakeCommand::MarkReady) => TakeState::Ready,
            (TakeState::Ready, TakeCommand::StartCountdown) => TakeState::Countdown,
            (TakeState::Ready, TakeCommand::StartRecording { capture_epoch, at_ns }) => {
                self.capture_epoch = Some(*capture_epoch);
                self.capture_started_at_ns = Some(*at_ns);
                self.input_health = InputHealth::Healthy;
                effects.push(TakeEffect::ActivateCaptureEpoch(*capture_epoch));
                TakeState::Recording
            }
            (TakeState::Countdown, TakeCommand::StartRecording { capture_epoch, at_ns }) => {
                self.capture_epoch = Some(*capture_epoch);
                self.capture_started_at_ns = Some(*at_ns);
                self.input_health = InputHealth::Healthy;
                effects.push(TakeEffect::ActivateCaptureEpoch(*capture_epoch));
                TakeState::Recording
            }
            (TakeState::Recording, TakeCommand::Pause { at_ns }) => {
                effects.push(TakeEffect::WritePauseBoundary(*at_ns));
                TakeState::Paused
            }
            (TakeState::Paused, TakeCommand::Resume { at_ns }) => {
                effects.push(TakeEffect::WriteResumeBoundary(*at_ns));
                TakeState::Recording
            }
            (TakeState::Recording, TakeCommand::Stop { at_ns })
            | (TakeState::Paused, TakeCommand::Stop { at_ns }) => {
                self.capture_ended_at_ns = Some(*at_ns);
                self.finalization_status = FinalizationStatus::Running;
                effects.push(TakeEffect::CloseScoreableInputGate(*at_ns));
                effects.push(TakeEffect::DrainAndSealTrace);
                effects.push(TakeEffect::BeginFinalization);
                TakeState::Finalizing
            }
            (TakeState::Finalizing, TakeCommand::FinalizeSucceeded) => {
                self.finalization_status = FinalizationStatus::Succeeded;
                self.report_revision = self.report_revision.saturating_add(1);
                effects.push(TakeEffect::SealFinalReport);
                TakeState::Completed
            }
            (TakeState::Finalizing, TakeCommand::FinalizeFailed { reason }) => {
                self.finalization_status = FinalizationStatus::Failed;
                effects.push(TakeEffect::PreserveTraceAndReason(reason.clone()));
                TakeState::Failed
            }
            (state, TakeCommand::Abort { reason, at_ns }) if !state.is_terminal() => {
                if matches!(state, TakeState::Recording | TakeState::Paused) {
                    self.capture_ended_at_ns = Some(*at_ns);
                    effects.push(TakeEffect::CloseScoreableInputGate(*at_ns));
                }
                effects.push(TakeEffect::PreserveTraceAndReason(reason.clone()));
                TakeState::Aborted
            }
            (state, TakeCommand::Fail { reason, at_ns }) if !state.is_terminal() => {
                if matches!(state, TakeState::Recording | TakeState::Paused) {
                    self.capture_ended_at_ns = Some(*at_ns);
                    effects.push(TakeEffect::CloseScoreableInputGate(*at_ns));
                }
                effects.push(TakeEffect::PreserveTraceAndReason(reason.clone()));
                TakeState::Failed
            }
            _ => {
                return Err(SessionError::InvalidTransition {
                    from: self.state,
                    command: command_name,
                });
            }
        };

        self.state = next_state;
        self.state_version = self.state_version.saturating_add(1);
        let receipt = TransitionReceipt {
            command_id: envelope.command_id.clone(),
            previous_state,
            current_state: self.state,
            state_version: self.state_version,
            duplicate: false,
            effects,
        };
        self.command_receipts.insert(envelope.command_id, receipt.clone());
        Ok(receipt)
    }

    pub fn set_input_health(&mut self, health: InputHealth) {
        // Health is intentionally orthogonal to lifecycle. Production code should
        // record this mutation in the event log and increment a suitable version.
        self.input_health = health;
    }
}

fn command_name(command: &TakeCommand) -> &'static str {
    match command {
        TakeCommand::Prepare => "Prepare",
        TakeCommand::MarkReady => "MarkReady",
        TakeCommand::StartCountdown => "StartCountdown",
        TakeCommand::StartRecording { .. } => "StartRecording",
        TakeCommand::Pause { .. } => "Pause",
        TakeCommand::Resume { .. } => "Resume",
        TakeCommand::Stop { .. } => "Stop",
        TakeCommand::FinalizeSucceeded => "FinalizeSucceeded",
        TakeCommand::FinalizeFailed { .. } => "FinalizeFailed",
        TakeCommand::Abort { .. } => "Abort",
        TakeCommand::Fail { .. } => "Fail",
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PracticeSessionCommand {
    Prepare,
    MarkReady,
    BeginReview,
    Complete,
    Abort,
    Fail,
}

#[derive(Clone, Debug)]
pub struct PracticeSession {
    pub session_id: PracticeSessionId,
    pub score_fingerprint: ScoreFingerprint,
    pub profile_snapshot_id: ProfileSnapshotId,
    pub state: PracticeSessionState,
    pub state_version: u64,
    pub take_ids: Vec<TakeId>,
    pub active_take_id: Option<TakeId>,
    command_receipts: HashMap<CommandId, PracticeSessionState>,
}

impl PracticeSession {
    pub fn new(
        session_id: PracticeSessionId,
        score_fingerprint: ScoreFingerprint,
        profile_snapshot_id: ProfileSnapshotId,
    ) -> Self {
        Self {
            session_id,
            score_fingerprint,
            profile_snapshot_id,
            state: PracticeSessionState::Draft,
            state_version: 0,
            take_ids: Vec::new(),
            active_take_id: None,
            command_receipts: HashMap::new(),
        }
    }

    pub fn apply_command(
        &mut self,
        command_id: CommandId,
        expected_state_version: u64,
        command: PracticeSessionCommand,
    ) -> Result<PracticeSessionState, SessionError> {
        if let Some(previous_state) = self.command_receipts.get(&command_id) {
            return Ok(*previous_state);
        }
        if expected_state_version != self.state_version {
            return Err(SessionError::StaleStateVersion {
                expected: expected_state_version,
                actual: self.state_version,
            });
        }
        let next = match (self.state, command) {
            (PracticeSessionState::Draft, PracticeSessionCommand::Prepare) => PracticeSessionState::Preparing,
            (PracticeSessionState::Preparing, PracticeSessionCommand::MarkReady) => PracticeSessionState::Ready,
            (PracticeSessionState::Active, PracticeSessionCommand::BeginReview)
                if self.active_take_id.is_none() => PracticeSessionState::Reviewing,
            (PracticeSessionState::Reviewing, PracticeSessionCommand::Complete) => PracticeSessionState::Completed,
            (state, PracticeSessionCommand::Abort) if !state.is_terminal() && self.active_take_id.is_none() => PracticeSessionState::Aborted,
            (state, PracticeSessionCommand::Fail) if !state.is_terminal() => PracticeSessionState::Failed,
            // A completed review may be reopened for another practice take only via
            // a new PracticeSession; session completion is intentionally terminal.
            _ => return Err(SessionError::SessionCommandInvalid),
        };
        self.state = next;
        self.state_version = self.state_version.saturating_add(1);
        self.command_receipts.insert(command_id, next);
        Ok(next)
    }

    pub fn register_take(&mut self, take: &PerformanceTake) -> Result<(), SessionError> {
        if self.state.is_terminal() {
            return Err(SessionError::SessionTerminal);
        }
        if !matches!(self.state, PracticeSessionState::Ready | PracticeSessionState::Active) {
            return Err(SessionError::SessionCommandInvalid);
        }
        if take.session_id != self.session_id {
            return Err(SessionError::WrongTake);
        }
        if self.take_ids.contains(&take.take_id) {
            return Ok(()); // Idempotent registration for the same take.
        }
        if self.active_take_id.is_some() {
            return Err(SessionError::ActiveTakeExists);
        }
        self.take_ids.push(take.take_id.clone());
        self.active_take_id = Some(take.take_id.clone());
        self.state = PracticeSessionState::Active;
        self.state_version = self.state_version.saturating_add(1);
        Ok(())
    }

    pub fn release_take(&mut self, take: &PerformanceTake) -> Result<(), SessionError> {
        if take.session_id != self.session_id || !self.take_ids.contains(&take.take_id) {
            return Err(SessionError::TakeNotFound);
        }
        if self.active_take_id.as_ref() != Some(&take.take_id) {
            // A released historical take is a harmless no-op; another active take
            // must never be cleared by a stale completion event.
            return Ok(());
        }
        if !take.state.is_terminal() {
            return Err(SessionError::InvalidTransition {
                from: take.state,
                command: "ReleaseNonTerminalTake",
            });
        }
        self.active_take_id = None;
        self.state_version = self.state_version.saturating_add(1);
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MidiEventKind {
    NoteOn { pitch: u8, velocity: u8 },
    NoteOff { pitch: u8, velocity: u8 },
    ControlChange { controller: u8, value: u8 },
    Other { status: u8, data1: u8, data2: u8 },
}

/// Stamp this packet at the source callback / first receive boundary, before
/// placing it on an asynchronous queue. Never assign an epoch in the consumer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StampedMidiPacket {
    pub event_id: EventId,
    pub source_id: SourceId,
    pub capture_epoch: CaptureEpoch,
    pub source_sequence: EventSequence,
    pub received_at_ns: MonotonicNs,
    pub payload: MidiEventKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventRoutingDecision {
    AcceptedForTake { take_id: TakeId, packet: StampedMidiPacket },
    QuarantinedNoActiveEpoch { packet: StampedMidiPacket },
    QuarantinedEpochMismatch { expected: CaptureEpoch, packet: StampedMidiPacket },
    QuarantinedBeforeCaptureStart { packet: StampedMidiPacket },
    QuarantinedAfterCaptureStop { packet: StampedMidiPacket },
    QuarantinedSequenceRegression { previous: EventSequence, packet: StampedMidiPacket },
}

impl EventRoutingDecision {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::AcceptedForTake { .. } => "accepted",
            Self::QuarantinedNoActiveEpoch { .. } => "no_active_epoch",
            Self::QuarantinedEpochMismatch { .. } => "epoch_mismatch",
            Self::QuarantinedBeforeCaptureStart { .. } => "before_capture_start",
            Self::QuarantinedAfterCaptureStop { .. } => "after_capture_stop",
            Self::QuarantinedSequenceRegression { .. } => "sequence_regression",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RoutingStats {
    pub accepted: u64,
    pub no_active_epoch: u64,
    pub epoch_mismatch: u64,
    pub before_capture_start: u64,
    pub after_capture_stop: u64,
    pub sequence_regression: u64,
}

impl RoutingStats {
    pub fn quarantined_total(&self) -> u64 {
        self.no_active_epoch
            + self.epoch_mismatch
            + self.before_capture_start
            + self.after_capture_stop
            + self.sequence_regression
    }
}

#[derive(Clone, Debug)]
struct ActiveCapture {
    take_id: TakeId,
    epoch: CaptureEpoch,
    started_at_ns: MonotonicNs,
    stopped_at_ns: Option<MonotonicNs>,
    last_sequence_by_source: HashMap<SourceId, EventSequence>,
}

#[derive(Clone, Debug, Default)]
pub struct CaptureRouter {
    active: Option<ActiveCapture>,
    stats: RoutingStats,
}

impl CaptureRouter {
    pub fn begin_take(
        &mut self,
        take_id: TakeId,
        epoch: CaptureEpoch,
        started_at_ns: MonotonicNs,
    ) -> Result<(), SessionError> {
        if self.active.is_some() {
            return Err(SessionError::CaptureAlreadyActive);
        }
        self.active = Some(ActiveCapture {
            take_id,
            epoch,
            started_at_ns,
            stopped_at_ns: None,
            last_sequence_by_source: HashMap::new(),
        });
        self.stats = RoutingStats::default();
        Ok(())
    }

    pub fn stats(&self) -> &RoutingStats {
        &self.stats
    }

    /// Close the scoring gate. Late packets from this epoch can no longer be
    /// accepted; they must remain quarantined and must not be retagged as a new take.
    pub fn stop_take(&mut self, epoch: CaptureEpoch, stopped_at_ns: MonotonicNs) -> Result<(), SessionError> {
        let active = self.active.as_mut().ok_or(SessionError::NoActiveCapture)?;
        if active.epoch != epoch {
            return Err(SessionError::EpochMismatch { expected: active.epoch, received: epoch });
        }
        active.stopped_at_ns = Some(stopped_at_ns);
        Ok(())
    }

    /// Seal the old epoch after the caller has drained or quarantined queued items.
    pub fn seal_take(&mut self, epoch: CaptureEpoch) -> Result<(), SessionError> {
        let active = self.active.as_ref().ok_or(SessionError::NoActiveCapture)?;
        if active.epoch != epoch {
            return Err(SessionError::EpochMismatch { expected: active.epoch, received: epoch });
        }
        if active.stopped_at_ns.is_none() {
            return Err(SessionError::InvalidTransition { from: TakeState::Recording, command: "SealBeforeStop" });
        }
        self.active = None;
        Ok(())
    }

    pub fn route(&mut self, packet: StampedMidiPacket) -> EventRoutingDecision {
        let Some(active) = self.active.as_mut() else {
            self.stats.no_active_epoch += 1;
            return EventRoutingDecision::QuarantinedNoActiveEpoch { packet };
        };
        if packet.capture_epoch != active.epoch {
            self.stats.epoch_mismatch += 1;
            return EventRoutingDecision::QuarantinedEpochMismatch {
                expected: active.epoch,
                packet,
            };
        }
        if packet.received_at_ns < active.started_at_ns {
            self.stats.before_capture_start += 1;
            return EventRoutingDecision::QuarantinedBeforeCaptureStart { packet };
        }
        if let Some(stop_at_ns) = active.stopped_at_ns {
            if packet.received_at_ns > stop_at_ns {
                self.stats.after_capture_stop += 1;
                return EventRoutingDecision::QuarantinedAfterCaptureStop { packet };
            }
        }
        if let Some(previous) = active.last_sequence_by_source.get(&packet.source_id).copied() {
            if packet.source_sequence <= previous {
                self.stats.sequence_regression += 1;
                return EventRoutingDecision::QuarantinedSequenceRegression { previous, packet };
            }
        }
        active.last_sequence_by_source.insert(packet.source_id.clone(), packet.source_sequence);
        self.stats.accepted += 1;
        EventRoutingDecision::AcceptedForTake {
            take_id: active.take_id.clone(),
            packet,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorStatus {
    NotTracking,
    Confirmed,
    Tentative,
    Ambiguous,
    Lost,
}

impl CursorStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotTracking => "not_tracking",
            Self::Confirmed => "confirmed",
            Self::Tentative => "tentative",
            Self::Ambiguous => "ambiguous",
            Self::Lost => "lost",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CursorCandidate {
    pub occurrence_id: PlaybackOccurrenceId,
    pub measure_number: u32,
    pub beat_position: RationalBeat,
    /// Smaller is better. This is alignment cost, not a probability.
    pub alignment_cost: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CursorPosition {
    pub occurrence_id: PlaybackOccurrenceId,
    pub measure_number: u32,
    pub beat_position: RationalBeat,
    pub part_id: Option<String>,
    pub staff: Option<u8>,
    pub voice: Option<String>,
    pub evidence_through_event_seq: EventSequence,
    /// Confidence is a UI/diagnostic estimate, not a calibrated probability.
    pub confidence: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlaybackCursor {
    pub take_id: TakeId,
    pub status: CursorStatus,
    /// Current estimate; only authoritative as a current position when status is Confirmed.
    pub current_position: Option<CursorPosition>,
    /// Last reliable anchor retained for recovery and diagnostics.
    pub last_confirmed_anchor: Option<CursorPosition>,
    pub candidates: Vec<CursorCandidate>,
    pub last_processed_event_seq: Option<EventSequence>,
    pub last_updated_at_ns: Option<MonotonicNs>,
    pub reason_code: Option<String>,
}

impl PlaybackCursor {
    pub fn new(take_id: TakeId) -> Self {
        Self {
            take_id,
            status: CursorStatus::NotTracking,
            current_position: None,
            last_confirmed_anchor: None,
            candidates: Vec::new(),
            last_processed_event_seq: None,
            last_updated_at_ns: None,
            reason_code: None,
        }
    }

    pub fn update_confirmed(
        &mut self,
        take_id: &TakeId,
        position: CursorPosition,
        updated_at_ns: MonotonicNs,
    ) -> Result<(), SessionError> {
        if take_id != &self.take_id {
            return Err(SessionError::CursorTakeMismatch);
        }
        if !(0.0..=1.0).contains(&position.confidence) {
            return Err(SessionError::InvalidCursorConfidence);
        }
        if let Some(previous) = self.last_processed_event_seq {
            if position.evidence_through_event_seq < previous {
                return Err(SessionError::CursorSequenceRegression);
            }
        }
        self.last_processed_event_seq = Some(position.evidence_through_event_seq);
        self.last_updated_at_ns = Some(updated_at_ns);
        self.current_position = Some(position.clone());
        self.last_confirmed_anchor = Some(position);
        self.candidates.clear();
        self.status = CursorStatus::Confirmed;
        self.reason_code = None;
        Ok(())
    }

    pub fn update_tentative(
        &mut self,
        take_id: &TakeId,
        position: CursorPosition,
        candidates: Vec<CursorCandidate>,
        updated_at_ns: MonotonicNs,
        reason_code: impl Into<String>,
    ) -> Result<(), SessionError> {
        if take_id != &self.take_id {
            return Err(SessionError::CursorTakeMismatch);
        }
        if !(0.0..=1.0).contains(&position.confidence) {
            return Err(SessionError::InvalidCursorConfidence);
        }
        if let Some(previous) = self.last_processed_event_seq {
            if position.evidence_through_event_seq < previous {
                return Err(SessionError::CursorSequenceRegression);
            }
        }
        self.last_processed_event_seq = Some(position.evidence_through_event_seq);
        self.last_updated_at_ns = Some(updated_at_ns);
        self.current_position = Some(position);
        self.candidates = candidates;
        self.status = CursorStatus::Tentative;
        self.reason_code = Some(reason_code.into());
        Ok(())
    }

    pub fn update_ambiguous(
        &mut self,
        take_id: &TakeId,
        candidates: Vec<CursorCandidate>,
        last_processed_event_seq: Option<EventSequence>,
        updated_at_ns: MonotonicNs,
        reason_code: impl Into<String>,
    ) -> Result<(), SessionError> {
        if take_id != &self.take_id {
            return Err(SessionError::CursorTakeMismatch);
        }
        if let (Some(previous), Some(received)) = (self.last_processed_event_seq, last_processed_event_seq) {
            if received < previous {
                return Err(SessionError::CursorSequenceRegression);
            }
        }
        self.current_position = None;
        self.candidates = candidates;
        self.last_processed_event_seq = last_processed_event_seq.or(self.last_processed_event_seq);
        self.last_updated_at_ns = Some(updated_at_ns);
        self.status = CursorStatus::Ambiguous;
        self.reason_code = Some(reason_code.into());
        Ok(())
    }

    pub fn mark_lost(&mut self, updated_at_ns: MonotonicNs, reason_code: impl Into<String>) {
        self.status = CursorStatus::Lost;
        self.current_position = None;
        self.last_updated_at_ns = Some(updated_at_ns);
        self.reason_code = Some(reason_code.into());
        // Keep the last confirmed anchor for diagnostics/reacquisition, but do not
        // present it as the current confirmed position without checking status.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_take() -> PerformanceTake {
        PerformanceTake::new(
            TakeId::from("take-1"),
            PracticeSessionId::from("session-1"),
            1,
            ScoreFingerprint::from("score-a"),
            ProfileSnapshotId::from("profile-a"),
        )
    }

    fn cmd(id: &str, version: u64, command: TakeCommand) -> CommandEnvelope {
        CommandEnvelope {
            command_id: CommandId::from(id),
            expected_state_version: version,
            command,
        }
    }

    fn bring_to_ready(take: &mut PerformanceTake) {
        take.apply_command(cmd("prepare", 0, TakeCommand::Prepare)).unwrap();
        take.apply_command(cmd("ready", 1, TakeCommand::MarkReady)).unwrap();
    }

    fn packet(epoch: u64, seq: u64, at: u64) -> StampedMidiPacket {
        StampedMidiPacket {
            event_id: EventId::new(format!("event-{seq}")),
            source_id: SourceId::from("keyboard-1"),
            capture_epoch: epoch,
            source_sequence: seq,
            received_at_ns: at,
            payload: MidiEventKind::NoteOn { pitch: 60, velocity: 90 },
        }
    }

    #[test]
    fn take_normal_lifecycle_reaches_completed() {
        let mut take = make_take();
        bring_to_ready(&mut take);
        take.apply_command(cmd("start", 2, TakeCommand::StartRecording { capture_epoch: 11, at_ns: 100 })).unwrap();
        take.apply_command(cmd("stop", 3, TakeCommand::Stop { at_ns: 500 })).unwrap();
        assert_eq!(take.state, TakeState::Finalizing);
        take.apply_command(cmd("finalize", 4, TakeCommand::FinalizeSucceeded)).unwrap();
        assert_eq!(take.state, TakeState::Completed);
        assert_eq!(take.report_revision, 1);
    }

    #[test]
    fn stale_command_is_rejected() {
        let mut take = make_take();
        let error = take.apply_command(cmd("prepare", 99, TakeCommand::Prepare)).unwrap_err();
        assert_eq!(error, SessionError::StaleStateVersion { expected: 99, actual: 0 });
    }

    #[test]
    fn duplicate_command_is_idempotent() {
        let mut take = make_take();
        let first = take.apply_command(cmd("prepare", 0, TakeCommand::Prepare)).unwrap();
        let duplicate = take.apply_command(cmd("prepare", 0, TakeCommand::Prepare)).unwrap();
        assert_eq!(first.current_state, TakeState::Preparing);
        assert!(duplicate.duplicate);
        assert!(duplicate.effects.is_empty());
        assert_eq!(take.state_version, 1);
    }

    #[test]
    fn completed_take_rejects_new_recording() {
        let mut take = make_take();
        bring_to_ready(&mut take);
        take.apply_command(cmd("start", 2, TakeCommand::StartRecording { capture_epoch: 2, at_ns: 10 })).unwrap();
        take.apply_command(cmd("stop", 3, TakeCommand::Stop { at_ns: 20 })).unwrap();
        take.apply_command(cmd("finish", 4, TakeCommand::FinalizeSucceeded)).unwrap();
        let error = take.apply_command(cmd("start-again", 5, TakeCommand::StartRecording { capture_epoch: 3, at_ns: 30 })).unwrap_err();
        assert!(matches!(error, SessionError::InvalidTransition { .. }));
    }

    #[test]
    fn practice_session_allows_only_one_active_take() {
        let mut session = PracticeSession::new(
            PracticeSessionId::from("session-1"),
            ScoreFingerprint::from("score-a"),
            ProfileSnapshotId::from("profile-a"),
        );
        session.apply_command(CommandId::from("session-prepare"), 0, PracticeSessionCommand::Prepare).unwrap();
        session.apply_command(CommandId::from("session-ready"), 1, PracticeSessionCommand::MarkReady).unwrap();
        let take1 = make_take();
        session.register_take(&take1).unwrap();
        let take2 = PerformanceTake::new(
            TakeId::from("take-2"),
            PracticeSessionId::from("session-1"),
            2,
            ScoreFingerprint::from("score-a"),
            ProfileSnapshotId::from("profile-a"),
        );
        assert_eq!(session.register_take(&take2), Err(SessionError::ActiveTakeExists));
    }

    #[test]
    fn old_epoch_packet_cannot_be_misattributed_to_new_take() {
        let mut router = CaptureRouter::default();
        router.begin_take(TakeId::from("take-a"), 100, 10).unwrap();
        assert!(matches!(router.route(packet(100, 1, 11)), EventRoutingDecision::AcceptedForTake { .. }));
        router.stop_take(100, 20).unwrap();
        router.seal_take(100).unwrap();
        router.begin_take(TakeId::from("take-b"), 101, 30).unwrap();
        assert!(matches!(router.route(packet(100, 2, 31)), EventRoutingDecision::QuarantinedEpochMismatch { .. }));
        assert!(matches!(router.route(packet(101, 1, 31)), EventRoutingDecision::AcceptedForTake { take_id: TakeId(ref id), .. } if id == "take-b"));
    }

    #[test]
    fn packet_after_stop_is_quarantined() {
        let mut router = CaptureRouter::default();
        router.begin_take(TakeId::from("take-a"), 5, 100).unwrap();
        router.stop_take(5, 200).unwrap();
        assert!(matches!(router.route(packet(5, 1, 201)), EventRoutingDecision::QuarantinedAfterCaptureStop { .. }));
    }

    #[test]
    fn per_source_sequence_must_increase() {
        let mut router = CaptureRouter::default();
        router.begin_take(TakeId::from("take-a"), 5, 100).unwrap();
        assert!(matches!(router.route(packet(5, 4, 110)), EventRoutingDecision::AcceptedForTake { .. }));
        assert!(matches!(router.route(packet(5, 4, 120)), EventRoutingDecision::QuarantinedSequenceRegression { .. }));
    }

    #[test]
    fn cursor_rejects_update_for_another_take() {
        let mut cursor = PlaybackCursor::new(TakeId::from("take-a"));
        let position = CursorPosition {
            occurrence_id: PlaybackOccurrenceId::from("occ-8-first-pass"),
            measure_number: 8,
            beat_position: RationalBeat::new(1, 2).unwrap(),
            part_id: Some("piano".to_owned()),
            staff: Some(1),
            voice: Some("right-hand".to_owned()),
            evidence_through_event_seq: 4,
            confidence: 0.95,
        };
        assert_eq!(cursor.update_confirmed(&TakeId::from("take-b"), position, 123), Err(SessionError::CursorTakeMismatch));
    }

    #[test]
    fn cursor_can_be_ambiguous_without_forcing_a_position() {
        let mut cursor = PlaybackCursor::new(TakeId::from("take-a"));
        let candidates = vec![
            CursorCandidate { occurrence_id: PlaybackOccurrenceId::from("measure-1-pass-1"), measure_number: 1, beat_position: RationalBeat::new(0, 1).unwrap(), alignment_cost: 0.2 },
            CursorCandidate { occurrence_id: PlaybackOccurrenceId::from("measure-1-pass-2"), measure_number: 1, beat_position: RationalBeat::new(0, 1).unwrap(), alignment_cost: 0.22 },
        ];
        cursor.update_ambiguous(&TakeId::from("take-a"), candidates, Some(10), 500, "repeat_pass_ambiguous").unwrap();
        assert_eq!(cursor.status, CursorStatus::Ambiguous);
        assert_eq!(cursor.candidates.len(), 2);
        assert!(cursor.current_position.is_none());
        assert!(cursor.last_confirmed_anchor.is_none());
    }


    #[test]
    fn lost_cursor_keeps_anchor_but_clears_current_estimate() {
        let mut cursor = PlaybackCursor::new(TakeId::from("take-a"));
        let position = CursorPosition {
            occurrence_id: PlaybackOccurrenceId::from("occ-8-first-pass"),
            measure_number: 8,
            beat_position: RationalBeat::new(1, 2).unwrap(),
            part_id: None,
            staff: None,
            voice: None,
            evidence_through_event_seq: 10,
            confidence: 0.9,
        };
        cursor.update_confirmed(&TakeId::from("take-a"), position, 100).unwrap();
        cursor.mark_lost(200, "no_match_window");
        assert_eq!(cursor.status, CursorStatus::Lost);
        assert!(cursor.current_position.is_none());
        assert!(cursor.last_confirmed_anchor.is_some());
    }

    #[test]
    fn rational_beat_rejects_zero_denominator() {
        assert_eq!(RationalBeat::new(1, 0), Err(SessionError::InvalidBeatDenominator));
    }

    #[test]
    fn rational_beat_normalizes_equivalent_values() {
        assert_eq!(RationalBeat::new(1, 2).unwrap(), RationalBeat::new(2, 4).unwrap());
        assert_eq!(RationalBeat::new(0, 8).unwrap(), RationalBeat::new(0, 1).unwrap());
    }

    #[test]
    fn session_must_be_prepared_before_take_registration() {
        let mut session = PracticeSession::new(
            PracticeSessionId::from("session-x"),
            ScoreFingerprint::from("score-x"),
            ProfileSnapshotId::from("profile-x"),
        );
        assert_eq!(session.register_take(&make_take()), Err(SessionError::SessionCommandInvalid));
    }

    #[test]
    fn pause_resume_records_boundaries() {
        let mut take = make_take();
        bring_to_ready(&mut take);
        take.apply_command(cmd("start", 2, TakeCommand::StartRecording { capture_epoch: 11, at_ns: 100 })).unwrap();
        let pause = take.apply_command(cmd("pause", 3, TakeCommand::Pause { at_ns: 200 })).unwrap();
        assert_eq!(take.state, TakeState::Paused);
        assert!(pause.effects.contains(&TakeEffect::WritePauseBoundary(200)));
        let resume = take.apply_command(cmd("resume", 4, TakeCommand::Resume { at_ns: 350 })).unwrap();
        assert_eq!(take.state, TakeState::Recording);
        assert!(resume.effects.contains(&TakeEffect::WriteResumeBoundary(350)));
    }

    #[test]
    fn stop_from_paused_enters_finalizing() {
        let mut take = make_take();
        bring_to_ready(&mut take);
        take.apply_command(cmd("start", 2, TakeCommand::StartRecording { capture_epoch: 11, at_ns: 100 })).unwrap();
        take.apply_command(cmd("pause", 3, TakeCommand::Pause { at_ns: 200 })).unwrap();
        let receipt = take.apply_command(cmd("stop", 4, TakeCommand::Stop { at_ns: 300 })).unwrap();
        assert_eq!(take.state, TakeState::Finalizing);
        assert!(receipt.effects.contains(&TakeEffect::CloseScoreableInputGate(300)));
    }

    #[test]
    fn duplicate_stop_is_rejected_without_another_finalization() {
        let mut take = make_take();
        bring_to_ready(&mut take);
        take.apply_command(cmd("start", 2, TakeCommand::StartRecording { capture_epoch: 11, at_ns: 100 })).unwrap();
        take.apply_command(cmd("stop", 3, TakeCommand::Stop { at_ns: 200 })).unwrap();
        let error = take.apply_command(cmd("stop-again", 4, TakeCommand::Stop { at_ns: 300 })).unwrap_err();
        assert!(matches!(error, SessionError::InvalidTransition { .. }));
        assert_eq!(take.state, TakeState::Finalizing);
        assert_eq!(take.finalization_attempt, 0);
    }

    #[test]
    fn finalize_failure_lands_in_failed_without_report_revision() {
        let mut take = make_take();
        bring_to_ready(&mut take);
        take.apply_command(cmd("start", 2, TakeCommand::StartRecording { capture_epoch: 11, at_ns: 100 })).unwrap();
        take.apply_command(cmd("stop", 3, TakeCommand::Stop { at_ns: 200 })).unwrap();
        take.apply_command(cmd("fail", 4, TakeCommand::FinalizeFailed { reason: "disk_full".into() })).unwrap();
        assert_eq!(take.state, TakeState::Failed);
        assert_eq!(take.finalization_status, FinalizationStatus::Failed);
        assert_eq!(take.report_revision, 0);
    }

    #[test]
    fn abort_from_recording_closes_scoreable_gate() {
        let mut take = make_take();
        bring_to_ready(&mut take);
        take.apply_command(cmd("start", 2, TakeCommand::StartRecording { capture_epoch: 11, at_ns: 100 })).unwrap();
        let receipt = take.apply_command(cmd("abort", 3, TakeCommand::Abort { reason: "user".into(), at_ns: 250 })).unwrap();
        assert_eq!(take.state, TakeState::Aborted);
        assert!(receipt.effects.contains(&TakeEffect::CloseScoreableInputGate(250)));
        assert_eq!(take.capture_ended_at_ns, Some(250));
    }

    #[test]
    fn routing_stats_count_quarantine_reasons() {
        let mut router = CaptureRouter::default();
        router.begin_take(TakeId::from("take-a"), 5, 100).unwrap();
        assert!(matches!(router.route(packet(5, 1, 110)), EventRoutingDecision::AcceptedForTake { .. }));
        assert!(matches!(router.route(packet(4, 2, 120)), EventRoutingDecision::QuarantinedEpochMismatch { .. }));
        router.stop_take(5, 200).unwrap();
        assert!(matches!(router.route(packet(5, 3, 201)), EventRoutingDecision::QuarantinedAfterCaptureStop { .. }));
        assert_eq!(router.stats().accepted, 1);
        assert_eq!(router.stats().epoch_mismatch, 1);
        assert_eq!(router.stats().after_capture_stop, 1);
        assert_eq!(router.stats().quarantined_total(), 2);
    }
}
