//! v0.6 authoritative raw-MIDI event contract (see
//! docs/RHYTHM_TRAINER_EVENT_CONTRACT_REDESIGN_v0.6.md).
//!
//! Pipeline ownership:
//!   Transport adapters (TS/device/mock) capture RawMidiPackets — bytes and
//!   source clock metadata only. THIS module owns decoding, key lifecycle
//!   pairing, duration facts and diagnostics. No second decoder may exist in
//!   TypeScript, and no scoring may enter through a side door.
//!
//! Time semantics:
//!   - `captured_at_ms` belongs to `clock_domain_id`; times from different
//!     domains are never subtracted directly.
//!   - Key-down duration is computed from SOURCE time differences of a valid
//!     same-source pair; session-mapped times are for onset alignment only.
//!   - Nothing here reads the system clock. Replay feeds the same packets and
//!     must reproduce the same report bit-for-bit.

use crate::CoreError;
use std::collections::{BTreeMap, VecDeque};

pub const MIDI_CONTRACT_SCHEMA_VERSION: u32 = 1;
pub const MIDI_CONTRACT_ALGORITHM_VERSION: &str = "midi-contract-0.6.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MidiTransport {
    WebMidi,
    NodeMidi,
    Mock,
    Recording,
}

impl MidiTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WebMidi => "web-midi",
            Self::NodeMidi => "node-midi",
            Self::Mock => "mock",
            Self::Recording => "recording",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "web-midi" => Some(Self::WebMidi),
            "node-midi" => Some(Self::NodeMidi),
            "mock" => Some(Self::Mock),
            "recording" => Some(Self::Recording),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockQuality {
    Good,
    Estimated,
    Unstable,
    Unknown,
}

impl ClockQuality {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Good => "good",
            Self::Estimated => "estimated",
            Self::Unstable => "unstable",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "good" => Some(Self::Good),
            "estimated" => Some(Self::Estimated),
            "unstable" => Some(Self::Unstable),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }
}

/// Transport-boundary packet: bytes + source clock metadata. Nothing decoded.
#[derive(Debug, Clone, PartialEq)]
pub struct RawMidiPacket {
    pub source_id: String,
    /// Strictly increasing per source_id, counting EVERY received message
    /// (notes and controllers alike — otherwise lost CCs are undetectable).
    pub source_seq: u64,
    pub clock_domain_id: String,
    /// Source capture/event time in ms; never the Node receive time.
    pub captured_at_ms: f64,
    /// Optional JS handler execution time; diagnostics only.
    pub handler_at_ms: Option<f64>,
    /// Verbatim copy of the received message bytes.
    pub raw_bytes: Vec<u8>,
    pub transport: MidiTransport,
}

impl RawMidiPacket {
    pub fn validate(&self) -> Result<(), CoreError> {
        if self.source_id.trim().is_empty() {
            return Err(CoreError::InvalidEvent("source_id cannot be empty".to_string()));
        }
        if !self.captured_at_ms.is_finite() || self.captured_at_ms < 0.0 {
            return Err(CoreError::InvalidEvent(
                "captured_at_ms must be finite and non-negative".to_string(),
            ));
        }
        if let Some(handler) = self.handler_at_ms {
            if !handler.is_finite() || handler < 0.0 {
                return Err(CoreError::InvalidEvent(
                    "handler_at_ms must be finite and non-negative".to_string(),
                ));
            }
        }
        if self.raw_bytes.is_empty() {
            return Err(CoreError::InvalidEvent("raw_bytes cannot be empty".to_string()));
        }
        Ok(())
    }
}

/// Packet + session clock mapping as it enters the scoring core.
#[derive(Debug, Clone, PartialEq)]
pub struct IngestMidiPacket {
    pub packet: RawMidiPacket,
    /// Mapped session time; null when no credible mapping exists.
    pub session_time_ms: Option<f64>,
    pub clock_mapping_id: Option<String>,
    pub clock_uncertainty_ms: Option<f64>,
    pub clock_quality: ClockQuality,
}

impl IngestMidiPacket {
    pub fn validate(&self) -> Result<(), CoreError> {
        self.packet.validate()?;
        if let Some(session) = self.session_time_ms {
            if !session.is_finite() || session < 0.0 {
                return Err(CoreError::InvalidEvent(
                    "session_time_ms must be finite and non-negative".to_string(),
                ));
            }
        }
        Ok(())
    }

    fn source_time(&self) -> f64 {
        self.packet.captured_at_ms
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MidiEventOriginalEncoding {
    Status0x8n,
    NoteOnVelocity0,
}

impl MidiEventOriginalEncoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Status0x8n => "0x8n",
            Self::NoteOnVelocity0 => "0x9n-zero-velocity",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum MidiEventKind {
    NoteOn { note_number: u8, velocity: u8 },
    NoteOff { note_number: u8, release_velocity: Option<u8> },
    ControlChange { controller: u8, value: u8 },
    PolyphonicKeyPressure { note_number: u8, pressure: u8 },
    ChannelPressure { pressure: u8 },
    ProgramChange { program: u8 },
    PitchBend { value_14bit: u16 },
    Other { status: u8, data: Vec<u8> },
}

/// Rust-side decode of a raw packet. This is a derived view; the raw packet
/// stays the audit authority.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedMidiEvent {
    /// Deterministic: `{source_id}#{source_seq}`.
    pub event_id: String,
    pub source_id: String,
    pub source_seq: u64,
    /// 0..=15 for channel voice messages; None for non-channel data.
    pub channel: Option<u8>,
    pub source_time_ms: f64,
    pub session_time_ms: Option<f64>,
    pub clock_domain_id: String,
    pub clock_quality: ClockQuality,
    pub kind: MidiEventKind,
    /// False for truncated/unknown-length messages: logged, never acted on.
    pub complete: bool,
    /// For NoteOff: which wire encoding carried the release.
    pub original_encoding: Option<MidiEventOriginalEncoding>,
}

/// Structural diagnostics. Every abnormal input keeps its raw packet and
/// produces one of these — nothing is dropped for tidiness.
#[derive(Debug, Clone, PartialEq)]
pub struct MidiDiagnostic {
    pub code: &'static str,
    pub source_id: String,
    pub source_seq: Option<u64>,
    pub detail: String,
}

pub mod diagnostic_codes {
    pub const SEQUENCE_GAP: &str = "SEQUENCE_GAP";
    pub const DUPLICATE_OR_REGRESSED_SEQ: &str = "DUPLICATE_OR_REGRESSED_SEQ";
    pub const TIME_REGRESSION: &str = "TIME_REGRESSION";
    pub const CLOCK_DOMAIN_CHANGED: &str = "CLOCK_DOMAIN_CHANGED";
    pub const INVALID_PACKET: &str = "INVALID_PACKET";
    pub const TRUNCATED_MESSAGE: &str = "TRUNCATED_MESSAGE";
    pub const ORPHAN_NOTE_OFF: &str = "ORPHAN_NOTE_OFF";
    pub const MISSING_NOTE_OFF: &str = "MISSING_NOTE_OFF";
    pub const AMBIGUOUS_SAME_KEY_OVERLAP: &str = "AMBIGUOUS_SAME_KEY_OVERLAP";
    pub const SOURCE_DISCONNECTED: &str = "SOURCE_DISCONNECTED";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyPressStatus {
    Complete,
    MissingNoteOff,
    InterruptedByDisconnect,
    AmbiguousPairing,
    InvalidTime,
}

impl KeyPressStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::MissingNoteOff => "missing-note-off",
            Self::InterruptedByDisconnect => "interrupted-by-disconnect",
            Self::AmbiguousPairing => "ambiguous-pairing",
            Self::InvalidTime => "invalid-time",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct KeyPressObservation {
    /// Deterministic: the Note On's event_id.
    pub press_id: String,
    pub source_id: String,
    pub channel: u8,
    pub note_number: u8,
    pub velocity_on: u8,
    pub note_on_event_id: String,
    pub note_off_event_id: Option<String>,
    pub start_source_time_ms: f64,
    pub end_source_time_ms: Option<f64>,
    /// Same-source capture-time difference; only for `complete` presses.
    pub key_down_duration_ms: Option<f64>,
    pub status: KeyPressStatus,
    pub quality_reasons: Vec<String>,
    /// The Note On packet's source_seq — the join key for onset judgments.
    pub note_on_source_seq: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KeyLifecycleReport {
    pub schema_version: u32,
    pub algorithm_version: String,
    pub observations: Vec<KeyPressObservation>,
    pub diagnostics: Vec<MidiDiagnostic>,
}

#[derive(Debug, Clone, PartialEq)]
struct OpenPress {
    event_id: String,
    source_seq: u64,
    captured_at_ms: f64,
    velocity: u8,
}

/// Tracks key presses keyed by `(source_id, channel, note_number)`.
/// Same pitch on a different source or channel NEVER cross-pairs.
#[derive(Debug, Default)]
pub struct KeyLifecycleTracker {
    open: BTreeMap<(String, u8, u8), VecDeque<OpenPress>>,
    observations: Vec<KeyPressObservation>,
    diagnostics: Vec<MidiDiagnostic>,
    last_seq_by_source: BTreeMap<String, u64>,
    last_time_by_source: BTreeMap<String, f64>,
    clock_domain_by_source: BTreeMap<String, String>,
    seen_seq_by_source: BTreeMap<String, std::collections::BTreeSet<u64>>,
    /// Presses whose pairing is ambiguous (same-key overlap). FIFO still
    /// closes deterministically, but these records never get strict grades.
    ambiguous_press_ids: std::collections::BTreeSet<String>,
}

impl KeyLifecycleTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ingests one packet: integrity checks + decode + lifecycle update.
    /// Returns the decoded event when the packet produced one (caller may use
    /// Note On events to derive onset scoring input — this stays inside the
    /// core, so no TypeScript decode exists on the scoring path).
    pub fn ingest(&mut self, ingest: &IngestMidiPacket) -> Result<Option<DecodedMidiEvent>, CoreError> {
        ingest.validate()?;
        let packet = &ingest.packet;

        // Source sequence integrity: count every message, so a lost CC shows up.
        // Anomalies are diagnosed and health-lowered, but the packet is still
        // processed — real notes must not vanish for tidiness (spec §4).
        let seen = self.seen_seq_by_source.entry(packet.source_id.clone()).or_default();
        if let Some(&last_seq) = self.last_seq_by_source.get(&packet.source_id) {
            if packet.source_seq > last_seq + 1 {
                self.diagnostics.push(MidiDiagnostic {
                    code: diagnostic_codes::SEQUENCE_GAP,
                    source_id: packet.source_id.clone(),
                    source_seq: Some(packet.source_seq),
                    detail: format!("missing source_seq {}..={}", last_seq + 1, packet.source_seq - 1),
                });
            }
            if packet.source_seq <= last_seq || !seen.insert(packet.source_seq) {
                self.diagnostics.push(MidiDiagnostic {
                    code: diagnostic_codes::DUPLICATE_OR_REGRESSED_SEQ,
                    source_id: packet.source_id.clone(),
                    source_seq: Some(packet.source_seq),
                    detail: format!("source_seq {source_seq} repeats or regresses (last {last_seq}); processed with lowered health", source_seq = packet.source_seq, last_seq = last_seq),
                });
            }
        }
        seen.insert(packet.source_seq);
        let max_seq = self.last_seq_by_source.entry(packet.source_id.clone()).or_insert(0);
        if packet.source_seq > *max_seq {
            *max_seq = packet.source_seq;
        }

        // Time and clock-domain sanity within a source.
        if let Some(&last_time) = self.last_time_by_source.get(&packet.source_id) {
            if packet.captured_at_ms < last_time {
                self.diagnostics.push(MidiDiagnostic {
                    code: diagnostic_codes::TIME_REGRESSION,
                    source_id: packet.source_id.clone(),
                    source_seq: Some(packet.source_seq),
                    detail: format!("captured_at_ms went from {last_time} back to {}", packet.captured_at_ms),
                });
            }
        }
        self.last_time_by_source.insert(packet.source_id.clone(), packet.captured_at_ms);

        match self.clock_domain_by_source.get(&packet.source_id) {
            Some(domain) if domain != &packet.clock_domain_id => {
                self.diagnostics.push(MidiDiagnostic {
                    code: diagnostic_codes::CLOCK_DOMAIN_CHANGED,
                    source_id: packet.source_id.clone(),
                    source_seq: Some(packet.source_seq),
                    detail: format!("clock_domain_id changed from {domain} to {}", packet.clock_domain_id),
                });
            }
            None => {
                self.clock_domain_by_source.insert(packet.source_id.clone(), packet.clock_domain_id.clone());
            }
            _ => {}
        }

        let event = decode_ingest_packet(ingest)?;
        if !event.complete {
            self.diagnostics.push(MidiDiagnostic {
                code: diagnostic_codes::TRUNCATED_MESSAGE,
                source_id: packet.source_id.clone(),
                source_seq: Some(packet.source_seq),
                detail: "message lacks the data bytes its status byte requires; kept in log, not acted on".to_string(),
            });
            return Ok(Some(event));
        }

        match &event.kind {
            MidiEventKind::NoteOn { note_number, velocity } => {
                let key = (packet.source_id.clone(), event.channel.unwrap_or(0), *note_number);
                let queue = self.open.entry(key).or_default();
                if !queue.is_empty() {
                    // Same key pressed while still open: MIDI Note Off carries no
                    // press id, so pairing is genuinely ambiguous. FIFO stays the
                    // deterministic policy; strict grading is disabled for the
                    // affected records.
                    self.diagnostics.push(MidiDiagnostic {
                        code: diagnostic_codes::AMBIGUOUS_SAME_KEY_OVERLAP,
                        source_id: packet.source_id.clone(),
                        source_seq: Some(packet.source_seq),
                        detail: format!("note {note_number} re-pressed on channel {} while {} press(es) still open", event.channel.unwrap_or(0), queue.len()),
                    });
                    self.ambiguous_press_ids.insert(event.event_id.clone());
                    for open_press in queue.iter() {
                        self.ambiguous_press_ids.insert(open_press.event_id.clone());
                    }
                }
                queue.push_back(OpenPress {
                    event_id: event.event_id.clone(),
                    source_seq: packet.source_seq,
                    captured_at_ms: event.source_time_ms,
                    velocity: *velocity,
                });
            }
            MidiEventKind::NoteOff { note_number, .. } => {
                let key = (packet.source_id.clone(), event.channel.unwrap_or(0), *note_number);
                let closed = self.open.get_mut(&key).and_then(|queue| queue.pop_front());
                match closed {
                    Some(press) => {
                        let end = event.source_time_ms;
                        let ambiguous = self.ambiguous_press_ids.contains(&press.event_id);
                        let (status, duration, mut quality_reasons) = if end < press.captured_at_ms {
                            (KeyPressStatus::InvalidTime, None, vec!["release time earlier than press time".to_string()])
                        } else {
                            (KeyPressStatus::Complete, Some(end - press.captured_at_ms), Vec::new())
                        };
                        let status = if ambiguous && status == KeyPressStatus::Complete {
                            quality_reasons.push("same-key overlap: FIFO pairing is deterministic but not strict".to_string());
                            KeyPressStatus::AmbiguousPairing
                        } else {
                            status
                        };
                        self.observations.push(KeyPressObservation {
                            press_id: press.event_id.clone(),
                            source_id: packet.source_id.clone(),
                            channel: event.channel.unwrap_or(0),
                            note_number: *note_number,
                            velocity_on: press.velocity,
                            note_on_event_id: press.event_id.clone(),
                            note_off_event_id: Some(event.event_id.clone()),
                            start_source_time_ms: press.captured_at_ms,
                            end_source_time_ms: Some(end),
                            key_down_duration_ms: duration,
                            status,
                            quality_reasons,
                            note_on_source_seq: press.source_seq,
                        });
                    }
                    None => {
                        self.diagnostics.push(MidiDiagnostic {
                            code: diagnostic_codes::ORPHAN_NOTE_OFF,
                            source_id: packet.source_id.clone(),
                            source_seq: Some(packet.source_seq),
                            detail: format!("note {note_number} release with no open press; no duration produced"),
                        });
                    }
                }
            }
            _ => {}
        }
        Ok(Some(event))
    }

    /// Session end: every still-open press becomes `missing-note-off`.
    /// Never fabricates a release time.
    pub fn finish(&mut self) {
        let keys: Vec<(String, u8, u8)> = self.open.keys().cloned().collect();
        for key in keys {
            while let Some(press) = self.open.get_mut(&key).and_then(|queue| queue.pop_front()) {
                self.diagnostics.push(MidiDiagnostic {
                    code: diagnostic_codes::MISSING_NOTE_OFF,
                    source_id: key.0.clone(),
                    source_seq: Some(press.source_seq),
                    detail: format!("note {} still held at session end; no duration produced", key.2),
                });
                self.observations.push(KeyPressObservation {
                    press_id: press.event_id.clone(),
                    source_id: key.0.clone(),
                    channel: key.1,
                    note_number: key.2,
                    velocity_on: press.velocity,
                    note_on_event_id: press.event_id.clone(),
                    note_off_event_id: None,
                    start_source_time_ms: press.captured_at_ms,
                    end_source_time_ms: None,
                    key_down_duration_ms: None,
                    status: KeyPressStatus::MissingNoteOff,
                    quality_reasons: vec!["session finished while the key was still held".to_string()],
                    note_on_source_seq: press.source_seq,
                });
            }
        }
        self.open.clear();
    }

    /// A source vanished (USB unplug): its open presses are interrupted.
    pub fn source_disconnected(&mut self, source_id: &str) {
        let keys: Vec<(String, u8, u8)> = self
            .open
            .keys()
            .filter(|(sid, _, _)| sid == source_id)
            .cloned()
            .collect();
        for key in keys {
            while let Some(press) = self.open.get_mut(&key).and_then(|queue| queue.pop_front()) {
                self.observations.push(KeyPressObservation {
                    press_id: press.event_id.clone(),
                    source_id: key.0.clone(),
                    channel: key.1,
                    note_number: key.2,
                    velocity_on: press.velocity,
                    note_on_event_id: press.event_id.clone(),
                    note_off_event_id: None,
                    start_source_time_ms: press.captured_at_ms,
                    end_source_time_ms: None,
                    key_down_duration_ms: None,
                    status: KeyPressStatus::InterruptedByDisconnect,
                    quality_reasons: vec!["source disconnected before the key was released".to_string()],
                    note_on_source_seq: press.source_seq,
                });
            }
            self.open.remove(&key);
        }
        self.diagnostics.push(MidiDiagnostic {
            code: diagnostic_codes::SOURCE_DISCONNECTED,
            source_id: source_id.to_string(),
            source_seq: None,
            detail: "source disconnected; open presses marked interrupted".to_string(),
        });
    }

    pub fn into_report(self) -> KeyLifecycleReport {
        KeyLifecycleReport {
            schema_version: MIDI_CONTRACT_SCHEMA_VERSION,
            algorithm_version: MIDI_CONTRACT_ALGORITHM_VERSION.to_string(),
            observations: self.observations,
            diagnostics: self.diagnostics,
        }
    }
}

/// Deterministic batch helper: ingest all packets in order, then finish.
/// The same input sequence always yields the same report.
pub fn track_key_lifecycles(ingests: &[IngestMidiPacket]) -> Result<KeyLifecycleReport, CoreError> {
    let mut tracker = KeyLifecycleTracker::new();
    for ingest in ingests {
        tracker.ingest(ingest)?;
    }
    tracker.finish();
    Ok(tracker.into_report())
}

/// Decodes one ingest packet into a semantic event per the v0.6 §4 rules.
pub fn decode_ingest_packet(ingest: &IngestMidiPacket) -> Result<DecodedMidiEvent, CoreError> {
    let packet = &ingest.packet;
    packet.validate()?;
    let event_id = format!("{}#{}", packet.source_id, packet.source_seq);
    let status = packet.raw_bytes[0];
    let base = DecodedMidiEvent {
        event_id: event_id.clone(),
        source_id: packet.source_id.clone(),
        source_seq: packet.source_seq,
        channel: None,
        source_time_ms: packet.captured_at_ms,
        session_time_ms: ingest.session_time_ms,
        clock_domain_id: packet.clock_domain_id.clone(),
        clock_quality: ingest.clock_quality,
        kind: MidiEventKind::Other { status, data: packet.raw_bytes[1..].to_vec() },
        complete: false,
        original_encoding: None,
    };
    // System / non-channel status bytes: keep as Other, never invent a note.
    if status < 0x80 {
        return Ok(base);
    }
    let command = status & 0xf0;
    let channel = Some(status & 0x0f);
    let data1 = packet.raw_bytes.get(1).copied();
    let data2 = packet.raw_bytes.get(2).copied();

    let event = match command {
        0x80 => match (data1, data2) {
            (Some(note), Some(vel)) => DecodedMidiEvent {
                channel, kind: MidiEventKind::NoteOff { note_number: note, release_velocity: Some(vel) },
                original_encoding: Some(MidiEventOriginalEncoding::Status0x8n),
                complete: true, ..base
            },
            _ => return Ok(base), // truncated: stays Other/incomplete + diag by tracker
        },
        0x90 => match (data1, data2) {
            (Some(note), Some(0)) => DecodedMidiEvent {
                channel, kind: MidiEventKind::NoteOff { note_number: note, release_velocity: None },
                original_encoding: Some(MidiEventOriginalEncoding::NoteOnVelocity0),
                complete: true, ..base
            },
            (Some(note), Some(vel)) => DecodedMidiEvent {
                channel, kind: MidiEventKind::NoteOn { note_number: note, velocity: vel },
                complete: true, ..base
            },
            _ => return Ok(base),
        },
        0xa0 => match (data1, data2) {
            (Some(note), Some(pressure)) => DecodedMidiEvent {
                channel, kind: MidiEventKind::PolyphonicKeyPressure { note_number: note, pressure },
                complete: true, ..base
            },
            _ => return Ok(base),
        },
        0xb0 => match (data1, data2) {
            (Some(controller), Some(value)) => DecodedMidiEvent {
                // CC64/66/67 are control changes — never note releases.
                channel, kind: MidiEventKind::ControlChange { controller, value },
                complete: true, ..base
            },
            _ => return Ok(base),
        },
        0xc0 => match data1 {
            Some(program) => DecodedMidiEvent {
                channel, kind: MidiEventKind::ProgramChange { program },
                // Two-byte message: there is no data2 to read.
                complete: true, ..base
            },
            None => return Ok(base),
        },
        0xd0 => match data1 {
            Some(pressure) => DecodedMidiEvent {
                channel, kind: MidiEventKind::ChannelPressure { pressure },
                complete: true, ..base
            },
            None => return Ok(base),
        },
        0xe0 => match (data1, data2) {
            (Some(low), Some(high)) => DecodedMidiEvent {
                channel, kind: MidiEventKind::PitchBend { value_14bit: (low as u16) | ((high as u16) << 7) },
                complete: true, ..base
            },
            _ => return Ok(base),
        },
        _ => base,
    };
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(source_seq: u64, captured_at_ms: f64, raw_bytes: &[u8]) -> IngestMidiPacket {
        IngestMidiPacket {
            packet: RawMidiPacket {
                source_id: "mock-a".to_string(),
                source_seq,
                clock_domain_id: "mock-clock-01".to_string(),
                captured_at_ms,
                handler_at_ms: None,
                raw_bytes: raw_bytes.to_vec(),
                transport: MidiTransport::Mock,
            },
            session_time_ms: Some(captured_at_ms),
            clock_mapping_id: Some("fixture-clock-01".to_string()),
            clock_uncertainty_ms: Some(0.0),
            clock_quality: ClockQuality::Good,
        }
    }

    fn kind_of(event: &DecodedMidiEvent) -> String {
        match &event.kind {
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

    // --- decoder matrix (spec §10) ---

    #[test]
    fn decodes_90_3c_5a_as_channel0_note_on() {
        let event = decode_ingest_packet(&packet(1, 1000.0, &[0x90, 0x3c, 0x5a])).unwrap();
        assert_eq!(kind_of(&event), "note-on");
        assert_eq!(event.channel, Some(0));
        assert!(matches!(event.kind, MidiEventKind::NoteOn { note_number: 60, velocity: 90 }));
    }

    #[test]
    fn decodes_standard_80_note_off_with_release_velocity() {
        let event = decode_ingest_packet(&packet(1, 1000.0, &[0x80, 0x3c, 0x28])).unwrap();
        assert_eq!(kind_of(&event), "note-off");
        assert!(matches!(
            event.kind,
            MidiEventKind::NoteOff { note_number: 60, release_velocity: Some(40) }
        ));
        assert_eq!(event.original_encoding, Some(MidiEventOriginalEncoding::Status0x8n));
    }

    #[test]
    fn velocity_zero_note_on_is_a_note_off_not_a_silent_on() {
        let event = decode_ingest_packet(&packet(1, 2000.0, &[0x90, 64, 0])).unwrap();
        assert_eq!(kind_of(&event), "note-off");
        assert!(matches!(
            event.kind,
            MidiEventKind::NoteOff { note_number: 64, release_velocity: None }
        ));
        assert_eq!(event.original_encoding, Some(MidiEventOriginalEncoding::NoteOnVelocity0));
    }

    #[test]
    fn channel_0_and_15_boundaries_are_kept_internally() {
        assert_eq!(decode_ingest_packet(&packet(1, 0.0, &[0x90, 60, 90])).unwrap().channel, Some(0));
        assert_eq!(decode_ingest_packet(&packet(2, 0.0, &[0x9f, 60, 90])).unwrap().channel, Some(15));
    }

    #[test]
    fn cc64_66_67_stay_control_changes_and_never_close_keys() {
        for controller in [64u8, 66, 67] {
            let event = decode_ingest_packet(&packet(1, 0.0, &[0xb0, controller, 127])).unwrap();
            assert_eq!(kind_of(&event), "control-change");
            assert!(matches!(event.kind, MidiEventKind::ControlChange { controller: c, value: 127 } if c == controller));
        }
    }

    #[test]
    fn program_change_is_two_bytes_and_channel_pressure_is_handled() {
        let program = decode_ingest_packet(&packet(1, 0.0, &[0xc3, 12])).unwrap();
        assert_eq!(kind_of(&program), "program-change");
        assert!(matches!(program.kind, MidiEventKind::ProgramChange { program: 12 }));
        let pressure = decode_ingest_packet(&packet(2, 0.0, &[0xd0, 40])).unwrap();
        assert_eq!(kind_of(&pressure), "channel-pressure");
        assert!(matches!(pressure.kind, MidiEventKind::ChannelPressure { pressure: 40 }));
    }

    #[test]
    fn pitch_bend_combines_14_bit_value() {
        let event = decode_ingest_packet(&packet(1, 0.0, &[0xe0, 0x00, 0x40])).unwrap();
        assert!(matches!(event.kind, MidiEventKind::PitchBend { value_14bit: 0x2000 }));
    }

    #[test]
    fn truncated_and_unknown_messages_are_kept_but_marked_incomplete() {
        let truncated = decode_ingest_packet(&packet(1, 0.0, &[0x90, 0x3c])).unwrap();
        assert!(!truncated.complete);
        assert_eq!(kind_of(&truncated), "other");
        let system = decode_ingest_packet(&packet(2, 0.0, &[0xff, 0x00])).unwrap();
        assert!(!system.complete);
        assert!(matches!(system.kind, MidiEventKind::Other { status: 0xff, .. }));
    }

    // --- lifecycle (spec §5 / §10) ---

    #[test]
    fn key_down_duration_uses_same_source_capture_times() {
        let mut tracker = KeyLifecycleTracker::new();
        tracker.ingest(&packet(1, 1000.0, &[0x90, 60, 90])).unwrap();
        tracker.ingest(&packet(2, 1375.0, &[0x80, 60, 40])).unwrap();
        let report = tracker.into_report();
        assert_eq!(report.observations.len(), 1);
        let press = &report.observations[0];
        assert_eq!(press.status, KeyPressStatus::Complete);
        assert_eq!(press.key_down_duration_ms, Some(375.0));
        assert!(report.diagnostics.is_empty());
    }

    #[test]
    fn same_pitch_different_channel_or_source_never_cross_pairs() {
        let mut tracker = KeyLifecycleTracker::new();
        tracker.ingest(&packet(1, 3000.0, &[0x90, 60, 85])).unwrap(); // ch0
        tracker.ingest(&packet(2, 3010.0, &[0x91, 60, 75])).unwrap(); // ch1
        tracker.ingest(&packet(3, 3300.0, &[0x80, 60, 0])).unwrap();  // closes ch0
        tracker.ingest(&packet(4, 3400.0, &[0x81, 60, 0])).unwrap();  // closes ch1
        let report = tracker.into_report();
        assert_eq!(report.observations.len(), 2);
        assert_eq!(report.observations[0].key_down_duration_ms, Some(300.0));
        assert_eq!(report.observations[1].key_down_duration_ms, Some(390.0));
        assert_eq!(report.observations[0].channel, 0);
        assert_eq!(report.observations[1].channel, 1);
        assert!(report.diagnostics.is_empty());

        // Different source id: same isolation — each source pairs only itself.
        let mut tracker = KeyLifecycleTracker::new();
        let mut a_on = packet(1, 1000.0, &[0x90, 60, 90]);
        a_on.packet.source_id = "mock-a".to_string();
        let mut b_on = packet(1, 1000.0, &[0x90, 60, 90]);
        b_on.packet.source_id = "mock-b".to_string();
        let mut a_off = packet(2, 1200.0, &[0x80, 60, 0]);
        a_off.packet.source_id = "mock-a".to_string();
        let mut b_off = packet(2, 1500.0, &[0x80, 60, 0]);
        b_off.packet.source_id = "mock-b".to_string();
        tracker.ingest(&a_on).unwrap();
        tracker.ingest(&b_on).unwrap();
        tracker.ingest(&a_off).unwrap();
        tracker.ingest(&b_off).unwrap();
        let report = tracker.into_report();
        assert_eq!(report.observations.len(), 2);
        assert!(report.observations.iter().all(|o| o.status == KeyPressStatus::Complete));
        assert_eq!(report.observations[0].source_id, "mock-a");
        assert_eq!(report.observations[0].key_down_duration_ms, Some(200.0));
        assert_eq!(report.observations[1].source_id, "mock-b");
        assert_eq!(report.observations[1].key_down_duration_ms, Some(500.0));
    }

    #[test]
    fn repress_after_release_forms_two_complete_lifecycles() {
        let mut tracker = KeyLifecycleTracker::new();
        tracker.ingest(&packet(1, 1000.0, &[0x90, 60, 90])).unwrap();
        tracker.ingest(&packet(2, 1200.0, &[0x80, 60, 0])).unwrap();
        tracker.ingest(&packet(3, 1500.0, &[0x90, 60, 100])).unwrap();
        tracker.ingest(&packet(4, 1800.0, &[0x80, 60, 0])).unwrap();
        let report = tracker.into_report();
        assert_eq!(report.observations.len(), 2);
        assert!(report.observations.iter().all(|o| o.status == KeyPressStatus::Complete));
    }

    #[test]
    fn same_key_overlap_is_ambiguous_and_fifo_deterministic() {
        let mut tracker = KeyLifecycleTracker::new();
        tracker.ingest(&packet(1, 1000.0, &[0x90, 60, 90])).unwrap();
        tracker.ingest(&packet(2, 1100.0, &[0x90, 60, 100])).unwrap();
        tracker.ingest(&packet(3, 1200.0, &[0x80, 60, 0])).unwrap();
        tracker.ingest(&packet(4, 1300.0, &[0x80, 60, 0])).unwrap();
        let report = tracker.into_report();
        assert_eq!(report.observations.len(), 2);
        // FIFO: first off closes the first press. Both are flagged ambiguous —
        // neither may be used for strict duration grading.
        assert_eq!(report.observations[0].key_down_duration_ms, Some(200.0));
        assert_eq!(report.observations[1].key_down_duration_ms, Some(200.0));
        assert_eq!(report.observations[0].status, KeyPressStatus::AmbiguousPairing);
        assert_eq!(report.observations[1].status, KeyPressStatus::AmbiguousPairing);
        assert!(report.diagnostics.iter().any(|d| d.code == diagnostic_codes::AMBIGUOUS_SAME_KEY_OVERLAP));
    }

    #[test]
    fn orphan_note_off_is_a_diagnostic_without_a_pressed_note() {
        let mut tracker = KeyLifecycleTracker::new();
        tracker.ingest(&packet(1, 1000.0, &[0x80, 62, 0])).unwrap();
        let report = tracker.into_report();
        assert!(report.observations.is_empty());
        assert!(report.diagnostics.iter().any(|d| d.code == diagnostic_codes::ORPHAN_NOTE_OFF));
    }

    #[test]
    fn finish_marks_missing_note_off_without_fabricating_release() {
        let mut tracker = KeyLifecycleTracker::new();
        tracker.ingest(&packet(1, 1000.0, &[0x90, 60, 90])).unwrap();
        tracker.finish();
        let report = tracker.into_report();
        assert_eq!(report.observations.len(), 1);
        assert_eq!(report.observations[0].status, KeyPressStatus::MissingNoteOff);
        assert_eq!(report.observations[0].end_source_time_ms, None);
        assert_eq!(report.observations[0].key_down_duration_ms, None);
    }

    #[test]
    fn disconnect_interrupts_open_presses_of_that_source_only() {
        let mut tracker = KeyLifecycleTracker::new();
        let mut other = packet(1, 1000.0, &[0x90, 62, 90]);
        other.packet.source_id = "mock-b".to_string();
        tracker.ingest(&packet(1, 1000.0, &[0x90, 60, 90])).unwrap();
        tracker.ingest(&other).unwrap();
        tracker.source_disconnected("mock-a");
        let report = tracker.into_report();
        assert_eq!(report.observations.len(), 1);
        assert_eq!(report.observations[0].status, KeyPressStatus::InterruptedByDisconnect);
        assert_eq!(report.observations[0].source_id, "mock-a");
        assert!(report.diagnostics.iter().any(|d| d.code == diagnostic_codes::SOURCE_DISCONNECTED));
    }

    #[test]
    fn cc64_messages_do_not_touch_key_lifecycle() {
        let mut tracker = KeyLifecycleTracker::new();
        tracker.ingest(&packet(1, 1000.0, &[0xb0, 64, 127])).unwrap();
        tracker.ingest(&packet(2, 1500.0, &[0x90, 60, 90])).unwrap();
        tracker.ingest(&packet(3, 2000.0, &[0xb0, 64, 0])).unwrap();
        tracker.ingest(&packet(4, 2250.0, &[0x80, 60, 0])).unwrap();
        let report = tracker.into_report();
        assert_eq!(report.observations.len(), 1);
        assert_eq!(report.observations[0].key_down_duration_ms, Some(750.0));
        assert!(report.diagnostics.is_empty());
    }

    #[test]
    fn backward_time_sequence_gap_and_domain_change_produce_diagnostics() {
        let mut tracker = KeyLifecycleTracker::new();
        tracker.ingest(&packet(1, 1000.0, &[0x90, 60, 90])).unwrap();
        tracker.ingest(&packet(5, 900.0, &[0x80, 60, 0])).unwrap(); // seq jump + time regression
        let report = tracker.into_report();
        assert!(report.diagnostics.iter().any(|d| d.code == diagnostic_codes::SEQUENCE_GAP));
        assert!(report.diagnostics.iter().any(|d| d.code == diagnostic_codes::TIME_REGRESSION));
        assert_eq!(report.observations[0].status, KeyPressStatus::InvalidTime);

        let mut tracker = KeyLifecycleTracker::new();
        tracker.ingest(&packet(1, 1000.0, &[0x90, 60, 90])).unwrap();
        let mut switched = packet(2, 1100.0, &[0x80, 60, 0]);
        switched.packet.clock_domain_id = "some-other-domain".to_string();
        tracker.ingest(&switched).unwrap();
        let report = tracker.into_report();
        assert!(report.diagnostics.iter().any(|d| d.code == diagnostic_codes::CLOCK_DOMAIN_CHANGED));

        let mut tracker = KeyLifecycleTracker::new();
        tracker.ingest(&packet(2, 1000.0, &[0x90, 60, 90])).unwrap();
        tracker.ingest(&packet(2, 1100.0, &[0x80, 60, 0])).unwrap(); // duplicate seq
        let report = tracker.into_report();
        assert!(report.diagnostics.iter().any(|d| d.code == diagnostic_codes::DUPLICATE_OR_REGRESSED_SEQ));
        // The duplicate is processed (never silently dropped) but diagnosed.
        assert_eq!(report.observations.len(), 1);
        assert_eq!(report.observations[0].key_down_duration_ms, Some(100.0));
    }

    #[test]
    fn replay_is_deterministic() {
        let ingests = vec![
            packet(1, 1000.0, &[0x90, 60, 90]),
            packet(2, 1375.0, &[0x80, 60, 40]),
            packet(3, 1375.0, &[0xb0, 64, 127]),
            packet(4, 1500.0, &[0x90, 62, 80]),
            packet(5, 1900.0, &[0x80, 62, 0]),
        ];
        let first = track_key_lifecycles(&ingests).unwrap();
        let second = track_key_lifecycles(&ingests).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn rejects_invalid_ingest_packets() {
        assert!(track_key_lifecycles(&[packet(1, -1.0, &[0x90, 60, 90])]).is_err());
        let mut empty = packet(1, 0.0, &[0x90]);
        empty.packet.raw_bytes = Vec::new();
        assert!(track_key_lifecycles(&[empty]).is_err());
    }
}
