import type {
  GraphicalNote,
  Note as OsmdNote,
  OpenSheetMusicDisplay,
} from 'opensheetmusicdisplay';
import type { ScoreDocument, ScoreEvent } from '../domain/types';
import { beatToString, subtractBeat } from '../domain/rational';

export type HighlightState = 'current' | 'system' | 'user' | 'error' | 'muted' | 'default';

/**
 * Mapping version. Bump this whenever the anchor key or conflict policy changes;
 * the OSMD version is pinned in package.json and every upgrade must re-run the
 * anchor contract harness (osmd-anchor-contract.html).
 */
export const ANCHOR_MAPPING_VERSION = 'osmd-structural-2';

/** How precisely a target can be highlighted with the current OSMD build. */
export type HighlightPrecision = 'note' | 'chord';

export type AnchorStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';

export type AnchorConflictReason =
  | 'duplicate-osmd-note'
  | 'duplicate-score-event'
  | 'missing-onset'
  | 'missing-pitch';

export interface AnchorConflict {
  scoreEventId: string;
  /** Diagnostic key, never a source identity. */
  anchorKey: string | null;
  reason: AnchorConflictReason;
  /** Number of candidates that shared the key, when known. */
  candidateCount: number;
}

export interface RenderedNoteRef {
  scoreEventId: string;
  graphicalNotes: readonly GraphicalNote[];
  sourceNotes: readonly OsmdNote[];
  anchorKey: string;
  /**
   * 'chord' means the glyph is shared by several notes (OSMD colours the whole
   * chord), so a per-note highlight is not pixel-exact.
   */
  highlightPrecision: HighlightPrecision;
}

export interface MappingResult {
  byEventId: Map<string, RenderedNoteRef>;
  noteEventCount: number;
  mappedEventCount: number;
  unmappedEventIds: readonly string[];
  duplicateGraphicalRefs: readonly string[];
  conflicts: readonly AnchorConflict[];
  anchorStatus: AnchorStatus;
  mappingVersion: string;
  warnings: readonly string[];
  debugSample?: { sourceKeys: string[]; eventKeys: string[]; sourcePitches?: unknown[] };
}

export interface ScoreViewAdapter {
  buildMapping(score: ScoreDocument, renderer: OpenSheetMusicDisplay): MappingResult;
  highlightScoreEvent(scoreEventId: string, state: HighlightState): boolean;
  clearHighlights(): void;
}

const COLORS: Record<HighlightState, string> = {
  current: '#1d9b72',
  system: '#c34b58',
  user: '#2f6fdb',
  error: '#c34b58',
  muted: '#b9bdc5',
  default: '#20252d',
};

const COLOR_OPTIONS = {
  applyToNoteheads: true,
  applyToStem: true,
  applyToBeams: true,
  applyToFlag: true,
  applyToLedgerLines: true,
  applyToTies: true,
  applyToSlurs: true,
  applyToGlissandi: true,
};

function voiceNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

/**
 * Converts OSMD's measure-relative `VoiceEntry.Timestamp` (whole-note Fraction)
 * into a canonical quarter-beat key. Exact integer arithmetic; no float onset.
 */
function timestampToBeatKey(timestamp: { Numerator: number; Denominator: number } | undefined): string | null {
  if (!timestamp) return null;
  const numerator = Number(timestamp.Numerator) * 4;
  const denominator = Number(timestamp.Denominator);
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator === 0) return null;
  const factor = gcd(numerator, denominator);
  return `${numerator / factor}/${denominator / factor}`;
}

function anchorKey(measureIndex: number, staffIndex: number, voiceId: number, beatKey: string, midi: number): string {
  return `${measureIndex}:${staffIndex}:${voiceId}:${beatKey}:${midi}`;
}

interface OsmdCandidate {
  note: OsmdNote;
  key: string;
  midi: number;
}

/**
 * Adapter over public OSMD object-model APIs only:
 *   osmd.Sheet.SourceMeasures -> StaffEntries -> VoiceEntries -> Notes
 *   osmd.rules.GNote(note) -> GraphicalNote
 *
 * Identity policy (see SCORE_ANCHOR_SPIKE_REPORT.md):
 *   - OSMD 2.2.1 does not preserve MusicXML `note@id`, so there is no source id.
 *   - The anchor is a structural key: measure + staff + voice + exact rational
 *     onset + MIDI pitch. It is a derived anchor, NOT a global unique id.
 *   - Any key shared by more than one OSMD note or more than one score event is
 *     a conflict. Conflicts are never resolved by DOM order, VexFlow ids or
 *     geometry; they simply do not get a note-level anchor.
 *   - OSMD rests carry a bogus halfTone (observed 12), so rests are detected with
 *     isRest() and never enter the pitch buckets.
 */
export class OsmdScoreViewAdapter implements ScoreViewAdapter {
  private osmd: OpenSheetMusicDisplay;
  private mapping: MappingResult | null = null;

  constructor(osmd: OpenSheetMusicDisplay) {
    this.osmd = osmd;
  }

  buildMapping(score: ScoreDocument, renderer: OpenSheetMusicDisplay = this.osmd): MappingResult {
    this.osmd = renderer;
    const warnings: string[] = [];
    const sourceMeasures = renderer.Sheet?.SourceMeasures ?? [];
    if (!sourceMeasures.length) warnings.push('OSMD 尚未生成 SourceMeasures；请先 load/render');
    if (score.parts.length > 1) {
      warnings.push('多 part 映射仍按全局 staff 索引尝试；该组合尚未通过 anchor contract 验证');
    }

    const buckets = new Map<string, OsmdCandidate[]>();
    const sourceKeys: string[] = [];
    const sourcePitches: unknown[] = [];
    let unkeyableOsmdNotes = 0;

    sourceMeasures.forEach((measure, measureIndex) => {
      for (const vertical of measure.VerticalSourceStaffEntryContainers ?? []) {
        const staffEntries = vertical.StaffEntries ?? [];
        staffEntries.forEach((staffEntry, staffIndex) => {
          for (const voiceEntry of staffEntry.VoiceEntries ?? []) {
            const voiceId = voiceNumber(String(voiceEntry.ParentVoice?.VoiceId ?? 1), 1);
            const beatKey = timestampToBeatKey(voiceEntry.Timestamp);
            for (const note of voiceEntry.Notes ?? []) {
              const isRest = typeof note.isRest === 'function' ? note.isRest() : false;
              if (isRest) continue;
              const halfTone = Number(note.halfTone);
              // OSMD halfTone is one octave below MIDI (C4 = 48).
              const midi = Number.isFinite(halfTone) ? halfTone + 12 : null;
              if (midi === null || beatKey === null) {
                unkeyableOsmdNotes += 1;
                continue;
              }
              if (sourcePitches.length < 4) sourcePitches.push({
                short: note.Pitch?.ToStringShort?.() ?? null,
                midi,
                octave: note.Pitch?.Octave ?? null,
              });
              const key = anchorKey(measureIndex, staffIndex, voiceId, beatKey, midi);
              const bucket = buckets.get(key);
              if (bucket) bucket.push({ note, key, midi });
              else {
                buckets.set(key, [{ note, key, midi }]);
                if (sourceKeys.length < 8) sourceKeys.push(key);
              }
            }
          }
        });
      }
    });

    if (unkeyableOsmdNotes > 0) {
      warnings.push(`${unkeyableOsmdNotes} 个 OSMD 音符缺少可用的 onset/音高，无法建立结构锚点`);
    }

    const allEvents: { event: ScoreEvent; partStaffOffset: number }[] = [];
    let offset = 0;
    const chordSizes = new Map<string, number>();
    for (const part of score.parts) {
      for (const measure of part.measures) {
        for (const event of measure.events) {
          if (event.kind !== 'note') continue;
          allEvents.push({ event, partStaffOffset: offset });
          if (event.chordGroupId) {
            chordSizes.set(event.chordGroupId, (chordSizes.get(event.chordGroupId) ?? 0) + 1);
          }
        }
      }
      offset += part.staves;
    }

    // Domain-side key counts: two score events sharing a key cannot both be the
    // same anchor even if OSMD happens to have produced one note for it.
    const eventKeyCounts = new Map<string, number>();
    const eventKeysById = new Map<string, string | null>();
    for (const { event, partStaffOffset } of allEvents) {
      const midi = event.pitch?.midiNote ?? null;
      if (midi === null) {
        eventKeysById.set(event.id, null);
        continue;
      }
      const key = buildEventKey(score, event, partStaffOffset, midi);
      eventKeysById.set(event.id, key);
      eventKeyCounts.set(key, (eventKeyCounts.get(key) ?? 0) + 1);
    }

    const byEventId = new Map<string, RenderedNoteRef>();
    const eventKeys: string[] = [];
    const unmapped: string[] = [];
    const duplicates = new Set<string>();
    const conflicts: AnchorConflict[] = [];
    const usedGraphical = new Set<GraphicalNote>();
    let noteEventCount = 0;

    for (const { event } of allEvents) {
      noteEventCount += 1;
      const midi = event.pitch?.midiNote ?? null;
      if (midi === null) {
        unmapped.push(event.id);
        conflicts.push({ scoreEventId: event.id, anchorKey: null, reason: 'missing-pitch', candidateCount: 0 });
        continue;
      }
      const key = eventKeysById.get(event.id) ?? null;
      if (key === null) {
        unmapped.push(event.id);
        conflicts.push({ scoreEventId: event.id, anchorKey: null, reason: 'missing-onset', candidateCount: 0 });
        continue;
      }
      if (eventKeys.length < 8) eventKeys.push(key);

      const bucket = buckets.get(key) ?? [];
      if (bucket.length > 1) {
        unmapped.push(event.id);
        conflicts.push({ scoreEventId: event.id, anchorKey: key, reason: 'duplicate-osmd-note', candidateCount: bucket.length });
        continue;
      }
      if ((eventKeyCounts.get(key) ?? 0) > 1) {
        unmapped.push(event.id);
        conflicts.push({ scoreEventId: event.id, anchorKey: key, reason: 'duplicate-score-event', candidateCount: eventKeyCounts.get(key) ?? 0 });
        continue;
      }
      const candidate = bucket[0];
      if (!candidate) {
        unmapped.push(event.id);
        continue;
      }
      let graphical: GraphicalNote | undefined;
      try {
        const rules = (renderer as unknown as { rules: { GNote(note: OsmdNote): GraphicalNote } }).rules;
        graphical = rules.GNote(candidate.note);
      } catch {
        graphical = undefined;
      }
      if (!graphical) {
        unmapped.push(event.id);
        continue;
      }
      if (usedGraphical.has(graphical)) duplicates.add(event.id);
      else usedGraphical.add(graphical);
      byEventId.set(event.id, {
        scoreEventId: event.id,
        graphicalNotes: [graphical],
        sourceNotes: [candidate.note],
        anchorKey: key,
        highlightPrecision: event.chordGroupId && (chordSizes.get(event.chordGroupId) ?? 0) > 1 ? 'chord' : 'note',
      });
    }

    const unusedNotes = [...buckets.values()].reduce((sum, bucket) => sum + bucket.length, 0) - byEventId.size;
    if (unusedNotes > 0) warnings.push(`${unusedNotes} 个 OSMD 源音符没有对应领域事件`);
    if (unmapped.length) warnings.push(`${unmapped.length} 个领域音符事件未能映射到 OSMD 图形对象`);
    if (conflicts.length) warnings.push(`${conflicts.length} 个锚点冲突已按 fail-closed 处理，不做音符级高亮`);

    let anchorStatus: AnchorStatus;
    if (noteEventCount > 0 && byEventId.size === noteEventCount && conflicts.length === 0) anchorStatus = 'COMPLETE';
    else if (byEventId.size === 0) anchorStatus = 'UNAVAILABLE';
    else anchorStatus = 'PARTIAL';

    this.mapping = {
      byEventId,
      noteEventCount,
      mappedEventCount: byEventId.size,
      unmappedEventIds: unmapped,
      duplicateGraphicalRefs: [...duplicates],
      conflicts,
      anchorStatus,
      mappingVersion: ANCHOR_MAPPING_VERSION,
      warnings,
      debugSample: { sourceKeys, eventKeys, sourcePitches },
    };
    return this.mapping;
  }

  getGraphicalNotes(scoreEventId: string): readonly GraphicalNote[] {
    return this.mapping?.byEventId.get(scoreEventId)?.graphicalNotes ?? [];
  }

  getAnchorStatus(): AnchorStatus {
    return this.mapping?.anchorStatus ?? 'UNAVAILABLE';
  }

  /** Returns true only when a note-level (or documented chord-level) anchor exists. */
  highlightScoreEvent(scoreEventId: string, state: HighlightState): boolean {
    const ref = this.mapping?.byEventId.get(scoreEventId);
    if (!ref) return false;
    for (const graphical of ref.graphicalNotes) {
      try {
        graphical.setColor(COLORS[state], COLOR_OPTIONS);
      } catch {
        // A backend/version without colour support must not break the app.
      }
    }
    return true;
  }

  clearHighlights(): void {
    if (!this.mapping) return;
    for (const ref of this.mapping.byEventId.values()) {
      for (const graphical of ref.graphicalNotes) {
        try {
          graphical.setColor(COLORS.default, COLOR_OPTIONS);
        } catch {
          // Best effort only; mapping remains valid.
        }
      }
    }
  }
}

/** Builds the domain-side structural key, mirroring timestampToBeatKey(). */
function buildEventKey(score: ScoreDocument, event: ScoreEvent, partStaffOffset: number, midi: number): string {
  const measure = findMeasureForEvent(score, event);
  const beatInMeasure = measure ? subtractBeat(event.onsetBeat, measure.startBeat) : event.onsetBeat;
  return anchorKey(
    event.source.measureOrdinal - 1,
    partStaffOffset + event.source.staffNumber - 1,
    voiceNumber(event.source.voiceId, 1),
    beatToString(beatInMeasure),
    midi,
  );
}

function findMeasureForEvent(score: ScoreDocument, event: ScoreEvent) {
  for (const part of score.parts) {
    if (part.id !== event.source.partId) continue;
    const measure = part.measures.find((entry) => entry.ordinal === event.source.measureOrdinal);
    if (measure) return measure;
  }
  return undefined;
}

export function mappingSummary(mapping: MappingResult): {
  noteEventCount: number;
  mappedEventCount: number;
  unmapped: number;
  duplicates: number;
  conflicts: number;
  anchorStatus: AnchorStatus;
  mappingVersion: string;
  ok: boolean;
  warnings: readonly string[];
} {
  const conflicts = mapping.conflicts.length;
  return {
    noteEventCount: mapping.noteEventCount,
    mappedEventCount: mapping.mappedEventCount,
    unmapped: mapping.unmappedEventIds.length,
    duplicates: mapping.duplicateGraphicalRefs.length,
    conflicts,
    anchorStatus: mapping.anchorStatus,
    mappingVersion: mapping.mappingVersion,
    // A mapping is only trustworthy when every note event has exactly one
    // anchor and no key was ambiguous.
    ok: mapping.mappedEventCount === mapping.noteEventCount
      && mapping.unmappedEventIds.length === 0
      && conflicts === 0
      && mapping.duplicateGraphicalRefs.length === 0,
    warnings: mapping.warnings,
  };
}
