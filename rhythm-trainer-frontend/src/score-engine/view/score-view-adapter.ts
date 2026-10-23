import type {
  GraphicalNote,
  Note as OsmdNote,
  OpenSheetMusicDisplay,
} from 'opensheetmusicdisplay';
import type { ScoreDocument, ScoreEvent } from '../domain/types';

export type HighlightState = 'current' | 'system' | 'user' | 'error' | 'muted' | 'default';

export interface RenderedNoteRef {
  scoreEventId: string;
  graphicalNotes: readonly GraphicalNote[];
  sourceNotes: readonly OsmdNote[];
}

export interface MappingResult {
  byEventId: Map<string, RenderedNoteRef>;
  noteEventCount: number;
  mappedEventCount: number;
  unmappedEventIds: readonly string[];
  duplicateGraphicalRefs: readonly string[];
  warnings: readonly string[];
  debugSample?: { sourceKeys: string[]; eventKeys: string[]; sourcePitches?: unknown[] };
}

export interface ScoreViewAdapter {
  buildMapping(score: ScoreDocument, renderer: OpenSheetMusicDisplay): MappingResult;
  highlightScoreEvent(scoreEventId: string, state: HighlightState): void;
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

/**
 * Adapter over public OSMD object-model APIs only:
 *   osmd.Sheet.SourceMeasures -> StaffEntries -> VoiceEntries -> Notes
 *   osmd.rules.GNote(note) -> GraphicalNote
 * No SVG class names or private OSMD DOM structures are used.
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
      warnings.push('多 part 映射按全局 staff 索引尝试；当前 UI 主路径仍以钢琴双谱表为主');
    }

    const buckets = new Map<string, OsmdNote[]>();
    const sourceKeys: string[] = [];
    const sourcePitches: unknown[] = [];
    sourceMeasures.forEach((measure, measureIndex) => {
      for (const vertical of measure.VerticalSourceStaffEntryContainers ?? []) {
        const staffEntries = vertical.StaffEntries ?? [];
        staffEntries.forEach((staffEntry, staffIndex) => {
          for (const voiceEntry of staffEntry.VoiceEntries ?? []) {
            const voiceId = String(voiceEntry.ParentVoice?.VoiceId ?? 1);
            for (const note of voiceEntry.Notes ?? []) {
              // OSMD's Pitch octave is an internal 0-based/offset scale; the
              // public halfTone is the reliable MIDI-aligned identity.
              // OSMD 2.2.1 stores halfTone one octave below MIDI (C4 = 48);
              // the public Pitch.Octave is XML octave - 3. Normalize to MIDI.
              const halfTone = Number(note.halfTone) + 12;
              if (sourcePitches.length < 4) sourcePitches.push({
                short: note.Pitch?.ToStringShort(), halfTone, octave: note.Pitch?.Octave,
                fundamental: note.Pitch?.FundamentalNote, accidental: note.Pitch?.Accidental,
              });
              if (!Number.isInteger(halfTone)) continue;
              const key = `${measureIndex}:${staffIndex}:${voiceId}:${halfTone}`;
              const bucket = buckets.get(key);
              if (bucket) bucket.push(note);
              else {
                buckets.set(key, [note]);
                if (sourceKeys.length < 8) sourceKeys.push(key);
              }
            }
          }
        });
      }
    });

    const byEventId = new Map<string, RenderedNoteRef>();
    const eventKeys: string[] = [];
    const unmapped: string[] = [];
    const duplicates = new Set<string>();
    const usedGraphical = new Set<GraphicalNote>();
    let noteEventCount = 0;

    const allEvents: { event: ScoreEvent; partStaffOffset: number }[] = [];
    let offset = 0;
    for (const part of score.parts) {
      for (const measure of part.measures) {
        for (const event of measure.events) {
          if (event.kind !== 'note') continue;
          allEvents.push({ event, partStaffOffset: offset });
        }
      }
      offset += part.staves;
    }

    for (const { event, partStaffOffset: partOffset } of allEvents) {
      noteEventCount += 1;
      if (!event.pitch || event.pitch.midiNote === null) {
        unmapped.push(event.id);
        continue;
      }
      const measureIndex = event.source.measureOrdinal - 1;
      const staffIndex = partOffset + event.source.staffNumber - 1;
      const voiceId = String(voiceNumber(event.source.voiceId, 1));
      const key = `${measureIndex}:${staffIndex}:${voiceId}:${event.pitch.midiNote}`;
      if (eventKeys.length < 8) eventKeys.push(key);
      const bucket = buckets.get(key);
      const sourceNote = bucket?.shift();
      if (!sourceNote) {
        unmapped.push(event.id);
        continue;
      }
      let graphical: GraphicalNote | undefined;
      try {
        const rules = (renderer as unknown as { rules: { GNote(note: OsmdNote): GraphicalNote } }).rules;
        graphical = rules.GNote(sourceNote);
      } catch {
        graphical = undefined;
      }
      if (!graphical) {
        unmapped.push(event.id);
        continue;
      }
      if (usedGraphical.has(graphical)) {
        duplicates.add(event.id);
      } else {
        usedGraphical.add(graphical);
      }
      byEventId.set(event.id, {
        scoreEventId: event.id,
        graphicalNotes: [graphical],
        sourceNotes: [sourceNote],
      });
    }

    const unusedNotes = [...buckets.values()].reduce((sum, bucket) => sum + bucket.length, 0);
    if (unusedNotes > 0) warnings.push(`${unusedNotes} 个 OSMD 源音符没有对应领域事件`);
    if (unmapped.length) warnings.push(`${unmapped.length} 个领域音符事件未能映射到 OSMD 图形对象`);

    this.mapping = {
      byEventId,
      noteEventCount,
      mappedEventCount: byEventId.size,
      unmappedEventIds: unmapped,
      duplicateGraphicalRefs: [...duplicates],
      warnings,
      debugSample: { sourceKeys, eventKeys, sourcePitches },
    };
    return this.mapping;
  }

  getGraphicalNotes(scoreEventId: string): readonly GraphicalNote[] {
    return this.mapping?.byEventId.get(scoreEventId)?.graphicalNotes ?? [];
  }

  highlightScoreEvent(scoreEventId: string, state: HighlightState): void {
    const ref = this.mapping?.byEventId.get(scoreEventId);
    if (!ref) return;
    for (const graphical of ref.graphicalNotes) {
      try {
        graphical.setColor(COLORS[state], COLOR_OPTIONS);
      } catch {
        // A backend/version without color support must not break the app.
      }
    }
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

export function mappingSummary(mapping: MappingResult): {
  noteEventCount: number;
  mappedEventCount: number;
  unmapped: number;
  duplicates: number;
  warnings: readonly string[];
} {
  return {
    noteEventCount: mapping.noteEventCount,
    mappedEventCount: mapping.mappedEventCount,
    unmapped: mapping.unmappedEventIds.length,
    duplicates: mapping.duplicateGraphicalRefs.length,
    warnings: mapping.warnings,
  };
}
