//! R2-3a1: strongly-typed `PlanFingerprintPayloadV1` (serde) mirroring
//! `audit-r1/contracts/plan-fingerprint-payload-v1.schema.json` and the TS
//! `PlanFingerprintPayloadV1` (plan-fingerprint.ts:721-756).
//!
//! Contract-critical detail: OPTIONAL fields (sourceLocator.voiceId,
//! member.isTieOnset) use `Option<T>` with `skip_serializing_if` so an absent
//! value stays ABSENT in the re-serialization — serializing `null` instead
//! would change the canonical bytes and therefore the fingerprint.
//!
//! Round-trip guarantee asserted by the vector tests: deserializing any
//! committed vector payload into these types and serializing back MUST
//! produce the same canonical bytes as the raw-Value path.

use serde::{Deserialize, Serialize};

pub const FINGERPRINT_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RationalV1 {
    pub numerator: i64,
    pub denominator: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanFingerprintPayloadV1 {
    pub fingerprintSchemaVersion: i64,
    pub plannerVersion: String,
    pub scoreRevisionId: String,
    pub normalizerVersion: String,
    pub supportProfileVersion: String,
    pub scope: ScopeV1,
    pub repeatSelection: RepeatSelectionV1,
    pub tempo: TempoV1,
    pub targetGroups: Vec<TargetGroupV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeV1 {
    pub partId: String,
    pub range: RangeV1,
    pub hand: String,
    pub handMapping: HandMappingV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RangeV1 {
    #[serde(rename = "startMeasureOrdinal")]
    pub start_measure_ordinal: i64,
    #[serde(rename = "endMeasureOrdinal")]
    pub end_measure_ordinal: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandMappingV1 {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "mappingVersion")]
    pub mapping_version: String,
    pub source: String,
    pub parts: Vec<HandMappingPartV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandMappingPartV1 {
    pub partId: String,
    pub staves: Vec<HandMappingStaffV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandMappingStaffV1 {
    #[serde(rename = "staffNumber")]
    pub staff_number: i64,
    pub hand: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RepeatSelectionV1 {
    None { kind: NoneKind },
    RangeLoop {
        kind: RangeLoopKind,
        count: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum NoneKind {
    #[serde(rename = "none")]
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RangeLoopKind {
    #[serde(rename = "range-loop")]
    RangeLoop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TempoV1 {
    pub bpm: RationalV1,
    #[serde(rename = "ticksPerQuarter")]
    pub ticks_per_quarter: i64,
    #[serde(rename = "countInBeats")]
    pub count_in_beats: RationalV1,
    #[serde(rename = "timeOrigin")]
    pub time_origin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetGroupV1 {
    #[serde(rename = "groupIndex")]
    pub group_index: i64,
    #[serde(rename = "passIndex")]
    pub pass_index: i64,
    pub bar: i64,
    #[serde(rename = "onsetBeatFromRangeStart")]
    pub onset_beat_from_range_start: RationalV1,
    #[serde(rename = "durationBeat")]
    pub duration_beat: RationalV1,
    #[serde(rename = "beatInMeasure")]
    pub beat_in_measure: RationalV1,
    #[serde(rename = "staffNumbers")]
    pub staff_numbers: Vec<i64>,
    #[serde(rename = "voiceIds")]
    pub voice_ids: Vec<String>,
    pub members: Vec<MemberV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberV1 {
    #[serde(rename = "sourceLocator")]
    pub source_locator: SourceLocatorV1,
    pub pitch: PitchV1,
    #[serde(rename = "durationBeat")]
    pub duration_beat: RationalV1,
    /// Optional: absent stays absent in re-serialization (never `null`).
    #[serde(rename = "isTieOnset", skip_serializing_if = "Option::is_none")]
    pub is_tie_onset: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceLocatorV1 {
    pub partId: String,
    #[serde(rename = "measureOrdinal")]
    pub measure_ordinal: i64,
    #[serde(rename = "sourceOrdinal")]
    pub source_ordinal: i64,
    /// Optional: absent stays absent in re-serialization (never `null`).
    #[serde(rename = "voiceId", skip_serializing_if = "Option::is_none")]
    pub voice_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PitchV1 {
    #[serde(rename = "midiNote")]
    pub midi_note: i64,
    pub spelling: String,
}
