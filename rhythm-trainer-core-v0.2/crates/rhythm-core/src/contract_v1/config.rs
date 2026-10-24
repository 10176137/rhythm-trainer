//! R2-3a2: planner config input boundary. The JSON shape mirrors the frozen
//! `parity-case-bundle-v1.schema.json` `config` object; unknown fields are
//! rejected (`deny_unknown_fields`) and every contract constraint is checked
//! BEFORE any plan is produced — an invalid config can never yield a
//! seemingly-successful plan (fourth review item 3).

use serde::Deserialize;

use crate::contract_v1::error::ContractError;
use crate::contract_v1::rational::{contract_error, is_canonical, RationalV1};

pub const MAX_LOOP_PASSES: i64 = 32;
pub const MIN_BPM: i64 = 20;
pub const MAX_BPM: i64 = 300;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanRequestConfig {
    #[serde(rename = "partId")]
    pub part_id: String,
    pub range: ConfigRange,
    #[serde(rename = "repeatSelection")]
    pub repeat_selection: ConfigRepeatSelection,
    pub hand: String,
    #[serde(rename = "handMapping")]
    pub hand_mapping: ConfigHandMapping,
    pub bpm: ConfigRational,
    #[serde(rename = "ticksPerQuarter")]
    pub ticks_per_quarter: i64,
    #[serde(rename = "countInUs")]
    pub count_in_us: i64,
    #[serde(rename = "unsupportedNotationPolicy")]
    pub unsupported_notation_policy: String,
    #[serde(rename = "plannerVersion")]
    pub planner_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigRange {
    #[serde(rename = "startMeasureOrdinal")]
    pub start_measure_ordinal: i64,
    #[serde(rename = "endMeasureOrdinal")]
    pub end_measure_ordinal: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigRepeatSelection {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigHandMapping {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "mappingVersion")]
    pub mapping_version: String,
    pub source: String,
    pub parts: Vec<ConfigHandMappingPart>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigHandMappingPart {
    pub partId: String,
    pub staves: Vec<ConfigHandMappingStaff>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigHandMappingStaff {
    #[serde(rename = "staffNumber")]
    pub staff_number: i64,
    pub hand: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigRational {
    pub numerator: i64,
    pub denominator: i64,
}

/// Parses and fully validates a planner config. Returns the typed config or
/// the first contract violation (frozen codes; never a partial plan).
pub fn parse_plan_request_config(json: &str) -> Result<PlanRequestConfig, ContractError> {
    let config: PlanRequestConfig = serde_json::from_str(json)
        .map_err(|error| contract_error("SCHEMA_VIOLATION", error.to_string()))?;
    validate_plan_request_config(&config)?;
    Ok(config)
}

pub fn validate_plan_request_config(config: &PlanRequestConfig) -> Result<(), ContractError> {
    // Range: 1-based, ordered, non-empty.
    let (start, end) = (
        config.range.start_measure_ordinal,
        config.range.end_measure_ordinal,
    );
    if start < 1 || end < start {
        return Err(contract_error(
            "INVALID_RANGE",
            format!("invalid measure range: {start}–{end}"),
        ));
    }

    // Repeat selection: none, or range-loop with 1..=32.
    match config.repeat_selection.kind.as_str() {
        "none" => {}
        "range-loop" => match config.repeat_selection.count {
            Some(count) if (1..=MAX_LOOP_PASSES).contains(&count) => {}
            _ => {
                return Err(contract_error(
                    "INVALID_REPEAT_COUNT",
                    format!("range-loop count must be within 1–{MAX_LOOP_PASSES}"),
                ))
            }
        },
        other => {
            return Err(contract_error(
                "INVALID_REPEAT_SELECTION",
                format!("unknown repeat selection kind: {other}"),
            ))
        }
    }

    // Hand: the frozen three-value set.
    if !matches!(config.hand.as_str(), "left" | "right" | "both") {
        return Err(contract_error(
            "INVALID_HAND",
            format!("hand must be left|right|both, got {}", config.hand),
        ));
    }

    // Hand mapping: user/score-metadata only (clef heuristics are display-only
    // and rejected for strict practice, per the frozen HandMappingV1 contract).
    if !matches!(config.hand_mapping.source.as_str(), "user" | "score-metadata") {
        return Err(contract_error(
            "HAND_MAPPING_SOURCE_NOT_ALLOWED",
            format!(
                "hand mapping source {} is not allowed for strict practice",
                config.hand_mapping.source
            ),
        ));
    }
    if config.hand_mapping.parts.is_empty() {
        return Err(contract_error("HAND_MAPPING_INCOMPLETE", "hand mapping has no parts"));
    }
    for part in &config.hand_mapping.parts {
        if part.staves.is_empty() {
            return Err(contract_error(
                "HAND_MAPPING_INCOMPLETE",
                format!("hand mapping part {} has no staves", part.partId),
            ));
        }
        for staff in &part.staves {
            if staff.staff_number < 1 {
                return Err(contract_error(
                    "HAND_MAPPING_INCOMPLETE",
                    "staff numbers must be positive",
                ));
            }
            if !matches!(staff.hand.as_str(), "left" | "right") {
                return Err(contract_error(
                    "HAND_MAPPING_INCOMPLETE",
                    format!("staff hand must be left|right, got {}", staff.hand),
                ));
            }
        }
    }

    // BPM: positive, reduced, inside the frozen 20–300 product range.
    let bpm = &config.bpm;
    if bpm.denominator <= 0 || bpm.numerator <= 0 {
        return Err(contract_error("INVALID_BPM", "bpm must be positive"));
    }
    if !is_canonical(bpm.numerator, bpm.denominator) {
        return Err(contract_error("INVALID_RATIONAL", "bpm must be a reduced rational"));
    }
    // Exact bounds: 20 ≤ num/den ≤ 300 ⇔ 20·den ≤ num ≤ 300·den.
    if bpm.numerator < MIN_BPM * bpm.denominator || bpm.numerator > MAX_BPM * bpm.denominator {
        return Err(contract_error(
            "INVALID_BPM",
            format!("bpm must be within {MIN_BPM}–{MAX_BPM}"),
        ));
    }

    // PPQ / count-in.
    if config.ticks_per_quarter <= 0 {
        return Err(contract_error("INVALID_PPQ", "ticksPerQuarter must be positive"));
    }
    if config.count_in_us < 0 {
        return Err(contract_error("INVALID_TIME", "countInUs must be a non-negative integer"));
    }

    // Policy: the frozen two-value set.
    if !matches!(
        config.unsupported_notation_policy.as_str(),
        "reject-strict" | "allow-display-only"
    ) {
        return Err(contract_error(
            "INVALID_POLICY",
            format!(
                "unsupportedNotationPolicy must be reject-strict|allow-display-only, got {}",
                config.unsupported_notation_policy
            ),
        ));
    }

    // The common frozen plannerVersion is required non-empty.
    if config.planner_version.trim().is_empty() {
        return Err(contract_error("INVALID_PLANNER_VERSION", "plannerVersion must not be empty"));
    }
    let _ = is_canonical(1, 1); // keep the import referenced for future checks
    Ok(())
}
