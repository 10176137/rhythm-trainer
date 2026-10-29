// P1-4: hand and multi-part scope. Language-shaped per
// audit-r1/docs/HAND_AND_MULTIPART_CONTRACT.md (HandMappingV1 / PracticeScopeV1
// / ScopeIssueCode). Pure functions; no UI, no engine calls, deterministic.
import type { ScoreDocument } from '../domain/types';

export type PracticeHand = 'left' | 'right' | 'both';

export interface PianoHandDefaults {
  single: 'left' | 'right';
  upper: 'left' | 'right';
  lower: 'left' | 'right';
}

export const DEFAULT_PIANO_HANDS: PianoHandDefaults = { single: 'right', upper: 'right', lower: 'left' };

/** Apply the configured staff-number policy, not a clef inference. Per-score
 * overrides take precedence at the caller. Unknown layouts still need a map.
 * `source=user` represents the user's global policy, not per-score confirmation. */
export function buildDefaultPianoHandMapping(score: ScoreDocument, defaults: PianoHandDefaults): HandMappingV1 | null {
  if (score.parts.length !== 1) return null;
  const part = score.parts[0];
  const staffs = distinctStaffNumbers(score, part.id);
  if (staffs.some((staff) => staff !== 1 && staff !== 2) || part.staves > 2) return null;
  return buildUserHandMapping(part.id, staffs.map((staffNumber) => ({
    staffNumber,
    hand: staffs.length === 1 ? defaults.single : staffNumber === 1 ? defaults.upper : defaults.lower,
  })));
}

export type HandMappingSource = 'user' | 'score-metadata' | 'clef-heuristic';

export interface HandMappingV1 {
  schemaVersion: 1;
  mappingVersion: string;
  source: HandMappingSource;
  parts: Array<{
    partId: string;
    staves: Array<{ staffNumber: number; hand: Exclude<PracticeHand, 'both'> }>;
  }>;
}

export interface PracticeScopeV1 {
  schemaVersion: 1;
  partId: string;
  range: { startMeasureOrdinal: number; endMeasureOrdinal: number };
  hand: PracticeHand;
  handMapping: HandMappingV1;
}

export type ScopeIssueCode =
  | 'hand_mapping_missing'
  | 'hand_mapping_heuristic_not_allowed_for_strict'
  | 'hand_mapping_incomplete'
  | 'multiple_parts_require_part_selection'
  | 'range_part_mismatch'
  | 'range_empty_after_hand_filter';

export interface ScopeAssessment {
  ok: boolean;
  codes: ScopeIssueCode[];
  missingStaffs: Array<{ partId: string; staffNumber: number; eventCount: number }>;
}

/**
 * Counts notated note events of one part/staff inside the range. Rests, grace
 * and cue notes are not playable targets, matching the planner's filters.
 */
function countTargetEvents(
  score: ScoreDocument,
  partId: string,
  staffNumber: number,
  range: PracticeScopeV1['range'],
): number {
  let count = 0;
  for (const part of score.parts) {
    if (part.id !== partId) continue;
    for (const measure of part.measures) {
      if (measure.ordinal < range.startMeasureOrdinal || measure.ordinal > range.endMeasureOrdinal) continue;
      for (const event of measure.events) {
        if (event.kind !== 'note' || event.isGrace || event.isCue) continue;
        if (event.source.staffNumber === staffNumber) count += 1;
      }
    }
  }
  return count;
}

function mappingForPart(handMapping: HandMappingV1, partId: string) {
  return handMapping.parts.find((part) => part.partId === partId);
}

function distinctStaffNumbers(score: ScoreDocument, partId: string): number[] {
  const staffs = new Set<number>();
  for (const part of score.parts) {
    if (part.id !== partId) continue;
    for (const measure of part.measures) {
      for (const event of measure.events) staffs.add(event.source.staffNumber);
      for (const clef of measure.attributes.clefs) staffs.add(clef.staffNumber);
    }
  }
  if (staffs.size === 0) staffs.add(1);
  return [...staffs].sort((a, b) => a - b);
}

/**
 * Single authority for "may strict timed practice start with this scope?".
 * Rules (contract R1–R6):
 *   - hand must come from an explicit mapping (user or score-metadata);
 *     clef heuristics are display-only and rejected for strict practice;
 *   - every target event's staff in range must map to the selected hand
 *     (hand='both' requires every staff to be mapped at all);
 *   - the range must exist inside the selected part;
 *   - a multi-part score requires an explicit part selection (the caller picks
 *     partId; this function never assumes parts[0]).
 */
export function assessPracticeScope(score: ScoreDocument, scope: PracticeScopeV1): ScopeAssessment {
  const codes: ScopeIssueCode[] = [];
  const missingStaffs: ScopeAssessment['missingStaffs'] = [];

  const part = score.parts.find((entry) => entry.id === scope.partId);
  if (!part) {
    codes.push('range_part_mismatch');
    return { ok: false, codes, missingStaffs };
  }

  if (score.parts.length > 1) {
    // The partId must be an explicit selection. The pure function cannot tell a
    // user choice from a default, so callers that only have parts[0] must not
    // call this for multi-part scores (the UI gate refuses them outright).
    // A `selectedPart: true` flag on the scope would formalize this; until the
    // Part selector exists, multi-part scores are refused upstream.
    codes.push('multiple_parts_require_part_selection');
    return { ok: false, codes, missingStaffs };
  }

  if (!scope.handMapping || !Array.isArray(scope.handMapping.parts)) {
    codes.push('hand_mapping_missing');
    return { ok: false, codes, missingStaffs };
  }
  if (scope.handMapping.source === 'clef-heuristic') {
    codes.push('hand_mapping_heuristic_not_allowed_for_strict');
  }
  const mapping = mappingForPart(scope.handMapping, scope.partId);
  if (!mapping) {
    // No mapping entry for the selected part: report every staff of that part
    // that carries targets in range, so the user knows what to map.
    for (const staffNumber of distinctStaffNumbers(score, scope.partId)) {
      const eventCount = countTargetEvents(score, scope.partId, staffNumber, scope.range);
      if (eventCount > 0) missingStaffs.push({ partId: scope.partId, staffNumber, eventCount });
    }
    codes.push('hand_mapping_incomplete');
    return { ok: false, codes, missingStaffs };
  }

  const mappedStaffs = new Set(mapping.staves.map((staff) => staff.staffNumber));
  for (const staffNumber of distinctStaffNumbers(score, scope.partId)) {
    if (mappedStaffs.has(staffNumber)) continue;
    const eventCount = countTargetEvents(score, scope.partId, staffNumber, scope.range);
    // Staffs with targets in range are hard findings; a staff with no targets
    // in range is reported too (the mapping should be total for the part), but
    // only when it exists elsewhere in the part, so a wide-but-partial mapping
    // is still surfaced for the next range selection.
    missingStaffs.push({ partId: scope.partId, staffNumber, eventCount });
  }
  if (missingStaffs.length > 0) codes.push('hand_mapping_incomplete');

  // Range must have at least one playable note after the hand filter.
  let inRange = false;
  for (const measure of part.measures) {
    if (measure.ordinal < scope.range.startMeasureOrdinal || measure.ordinal > scope.range.endMeasureOrdinal) continue;
    for (const event of measure.events) {
      if (event.kind !== 'note' || event.isGrace || event.isCue) continue;
      const staff = mapping.staves.find((entry) => entry.staffNumber === event.source.staffNumber);
      if (!staff) continue;
      if (scope.hand !== 'both' && staff.hand !== scope.hand) continue;
      inRange = true;
      break;
    }
    if (inRange) break;
  }
  if (!inRange) codes.push('range_empty_after_hand_filter');

  return { ok: codes.length === 0, codes, missingStaffs };
}

/**
 * Builds the strict-permitted mapping for a single-part piano score from the
 * USER's hand choice: single staff means every target belongs to the selected
 * hand when hand !== 'both'; two staves require the user's per-staff choice.
 * This never reads clefs.
 */
export function buildUserHandMapping(
  partId: string,
  staves: Array<{ staffNumber: number; hand: Exclude<PracticeHand, 'both'> }>,
): HandMappingV1 {
  return {
    schemaVersion: 1,
    mappingVersion: 'hand-mapping-1',
    source: 'user',
    parts: [{ partId, staves }],
  };
}

/**
 * Derives a suggested (display-only) mapping from clefs for UI defaults.
 * The result MUST carry source='clef-heuristic' and is rejected by
 * assessPracticeScope for strict practice until the user confirms it.
 */
export function suggestClefHeuristicMapping(score: ScoreDocument, partId: string): HandMappingV1 {
  const part = score.parts.find((entry) => entry.id === partId);
  const firstMeasure = part?.measures[0];
  const staves = distinctStaffNumbers(score, partId).map((staffNumber) => {
    const clef = firstMeasure?.attributes.clefs.find((entry) => entry.staffNumber === staffNumber);
    return { staffNumber, hand: (clef?.sign === 'F' ? 'left' : 'right') as Exclude<PracticeHand, 'both'> };
  });
  return {
    schemaVersion: 1,
    mappingVersion: 'hand-mapping-1',
    source: 'clef-heuristic',
    parts: [{ partId, staves }],
  };
}

/**
 * Converts a hand mapping into the scoreEventId -> hand map that
 * filterPlaybackPlanByHand consumes, restricted to the scope's part/range.
 * Deterministic; missing entries are simply absent (the planner fails closed).
 */
export function handByScoreEventIdFromMapping(
  score: ScoreDocument,
  scope: PracticeScopeV1,
): Map<string, Exclude<PracticeHand, 'both'>> {
  const map = new Map<string, Exclude<PracticeHand, 'both'>>();
  const mapping = mappingForPart(scope.handMapping, scope.partId);
  if (!mapping) return map;
  for (const part of score.parts) {
    if (part.id !== scope.partId) continue;
    for (const measure of part.measures) {
      if (measure.ordinal < scope.range.startMeasureOrdinal || measure.ordinal > scope.range.endMeasureOrdinal) continue;
      for (const event of measure.events) {
        if (event.kind !== 'note' || event.isGrace || event.isCue) continue;
        const staff = mapping.staves.find((entry) => entry.staffNumber === event.source.staffNumber);
        if (staff) map.set(event.id, staff.hand);
      }
    }
  }
  return map;
}
