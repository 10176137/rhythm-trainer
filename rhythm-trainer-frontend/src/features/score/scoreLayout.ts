import type { ScoreMeasureMeta, ScoreNote } from '../../core/sampleScore';
import {
  STAFF_GEOMETRY,
  getStaffPlacement,
  getUnsupportedNotes,
  type StaffPlacement,
} from './staffMapping';

export interface ScoreBar {
  index: number;
  startX: number;
  endX: number;
  centerX: number;
  /** System row this bar belongs to (0-based). */
  systemIndex: number;
  /** Per-measure MusicXML timeline; never assume 4/4. */
  startBeat: number;
  durationBeats: number;
  beats: number;
  beatType: number;
  keyFifths: number;
  implicit: boolean;
  /** True when the meter differs from the previous bar in this system. */
  timeSignatureChange: boolean;
  /** True when the key differs from the previous bar in this system. */
  keySignatureChange: boolean;
}

export interface NoteLabelGeometry {
  nameX: number;
  nameY: number;
  badgeX: number;
  badgeY: number;
  badgeWidth: number;
  badgeHeight: number;
  badgeTextX: number;
  badgeTextY: number;
}

export interface NoteStemGeometry {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PositionedScoreNote {
  note: ScoreNote;
  placement: StaffPlacement;
  x: number;
  y: number;
  barIndex: number;
  beatInBar: number;
  systemIndex: number;
  headFilled: boolean;
  whole: boolean;
  flagCount: number;
  stem: NoteStemGeometry | null;
  ledgerLineYs: number[];
  label: NoteLabelGeometry;
}

export interface ScoreLayout {
  bars: ScoreBar[];
  notes: PositionedScoreNote[];
  unsupported: { note: ScoreNote; reason: string }[];
}

export interface ScoreSystemLayout {
  index: number;
  startBar: number;
  endBar: number;
  bars: ScoreBar[];
  notes: PositionedScoreNote[];
}

export interface ScoreSystemsLayout {
  systems: ScoreSystemLayout[];
  notes: PositionedScoreNote[];
  unsupported: { note: ScoreNote; reason: string }[];
}

export interface ScoreDisplayOptions {
  showNoteNames: boolean;
  showPositionHints: boolean;
}

/** Optional visible slice: bars are laid out like a fresh system starting at startBar. */
export interface ScoreLayoutWindow {
  startBar: number;
  barCount: number;
}

export interface ScoreSystemsOptions {
  measures?: readonly ScoreMeasureMeta[];
  /** Maximum bars in one row; density may force fewer. */
  barsPerSystem?: number;
  /** Soft budget of noteheads per row (a single dense bar may exceed it). */
  notesPerSystem?: number;
  /** Fixed layout width per bar; used to keep the score at a readable scale. */
  barWidth?: number;
}

export interface ScoreNoteViewModel extends PositionedScoreNote {
  showNoteName: boolean;
  showPositionHint: boolean;
}

export interface ScoreViewModel {
  bars: ScoreBar[];
  notes: ScoreNoteViewModel[];
  unsupported: { note: ScoreNote; reason: string }[];
}

export interface ScoreSystemViewModel {
  index: number;
  startBar: number;
  endBar: number;
  bars: ScoreBar[];
  notes: ScoreNoteViewModel[];
}

export interface ScoreSystemsViewModel {
  systems: ScoreSystemViewModel[];
  unsupported: { note: ScoreNote; reason: string }[];
}

function resolveMeasures(
  barCount: number,
  beatsPerBar: number,
  measures?: readonly ScoreMeasureMeta[],
): ScoreMeasureMeta[] {
  const safeBarCount = Math.max(1, barCount);
  const safeBeatsPerBar = Math.max(0.25, beatsPerBar);
  const resolved: ScoreMeasureMeta[] = [];
  const provided = measures ?? [];
  for (let index = 0; index < safeBarCount; index += 1) {
    const source = provided[index];
    if (source && Number.isFinite(source.startBeat) && Number.isFinite(source.durationBeats) && source.durationBeats > 0) {
      resolved.push({ ...source, bar: index + 1 });
      continue;
    }
    const previous = resolved[index - 1];
    const startBeat = previous ? previous.startBeat + previous.durationBeats : 0;
    resolved.push({
      bar: index + 1,
      startBeat,
      durationBeats: safeBeatsPerBar,
      beats: safeBeatsPerBar,
      beatType: 4,
      keyFifths: 0,
      implicit: false,
    });
  }
  return resolved;
}

function positionNote(
  note: ScoreNote,
  placement: StaffPlacement,
  x: number,
  barIndex: number,
  beatInBar: number,
  systemIndex: number,
): PositionedScoreNote {
  const y = placement.y;
  const whole = note.noteType === 'whole';
  const headFilled = note.noteType !== 'whole' && note.noteType !== 'half';
  const flagCount = note.noteType === 'eighth' ? 1 : note.noteType === '16th' ? 2 : 0;
  const stem = whole
    ? null
    : note.hand === 'right'
      ? { x1: x + 7.5, y1: y - 1, x2: x + 7.5, y2: y - 38 }
      : { x1: x - 7.5, y1: y + 1, x2: x - 7.5, y2: y + 38 };

  // Notes outside the staff get their label next to the note; notes inside
  // the staff use the shared annotation row so consecutive labels align.
  const belowStaff = placement.offsetFromBottomLine < 0;
  const aboveStaff = placement.kind === 'ledger-above' || placement.kind === 'above-staff';
  const labelBaseY = belowStaff
    ? y + 25
    : aboveStaff
      ? y - 20
      : note.staff === 'treble' ? 182 : 338;
  const labelOffsetX = aboveStaff ? (note.hand === 'right' ? -18 : 18) : 0;
  const badgeWidth = Math.max(32, placement.positionLabel.length * 10 + 10);
  const nameX = x + labelOffsetX;
  const label: NoteLabelGeometry = {
    nameX,
    nameY: labelBaseY,
    badgeX: nameX - badgeWidth / 2,
    badgeY: aboveStaff ? labelBaseY - 36 : labelBaseY + 7,
    badgeWidth,
    badgeHeight: 16,
    badgeTextX: nameX,
    badgeTextY: aboveStaff ? labelBaseY - 25 : labelBaseY + 19,
  };

  return {
    note,
    placement,
    x,
    y,
    barIndex,
    beatInBar,
    systemIndex,
    headFilled,
    whole,
    flagCount,
    stem,
    ledgerLineYs: placement.ledgerLineYs,
    label,
  };
}

/**
 * One system row. Bar widths follow the measure's effective duration from the
 * XML (4/4 = 4 quarter beats, 3/4 = 3, 6/8 = 3), so mixed meters and pickups
 * are not forced into a 4/4 grid.
 */
function layoutSystem(
  notes: readonly ScoreNote[],
  measures: readonly ScoreMeasureMeta[],
  systemIndex: number,
  barWidth?: number,
): ScoreSystemLayout {
  const weights = measures.map((measure) => Math.max(0.25, measure.durationBeats));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const availableWidth = barWidth !== undefined
    ? barWidth * measures.length
    : STAFF_GEOMETRY.staffEndX - STAFF_GEOMETRY.staffStartX;
  let cursor = STAFF_GEOMETRY.staffStartX;

  const bars: ScoreBar[] = measures.map((measure, index) => {
    const width = availableWidth * (weights[index] / totalWeight);
    const startX = cursor;
    cursor += width;
    const previous = measures[index - 1];
    return {
      index: measure.bar,
      startX,
      endX: cursor,
      centerX: (startX + cursor) / 2,
      systemIndex,
      startBeat: measure.startBeat,
      durationBeats: measure.durationBeats,
      beats: measure.beats,
      beatType: measure.beatType,
      keyFifths: measure.keyFifths ?? 0,
      implicit: !!measure.implicit,
      timeSignatureChange: Boolean(previous)
        && (previous.beats !== measure.beats || previous.beatType !== measure.beatType),
      keySignatureChange: Boolean(previous)
        && (previous.keyFifths ?? 0) !== (measure.keyFifths ?? 0),
    };
  });

  const measureByBar = new Map(measures.map((measure) => [measure.bar, measure]));
  const barByIndex = new Map(bars.map((bar) => [bar.index, bar]));
  const positioned: PositionedScoreNote[] = [];

  for (const note of notes) {
    const measure = measureByBar.get(note.bar);
    const bar = barByIndex.get(note.bar);
    if (!measure || !bar) continue;
    const placement = getStaffPlacement(note.staff, note.step, note.alter, note.octave);
    if (!placement) continue;

    const barWidth = bar.endX - bar.startX;
    const inset = Math.min(STAFF_GEOMETRY.firstBeatInset, barWidth * 0.25);
    const padding = Math.min(STAFF_GEOMETRY.lastBeatPadding, barWidth * 0.15);
    const usableWidth = Math.max(1, barWidth - inset - padding);
    const beatWidth = usableWidth / Math.max(0.25, measure.durationBeats);
    const beatInBar = Math.max(0, Math.min(measure.durationBeats, note.beat - measure.startBeat));
    const x = bar.startX + inset + beatInBar * beatWidth;
    positioned.push(positionNote(note, placement, x, note.bar - 1, beatInBar, systemIndex));
  }

  positioned.sort((a, b) => a.barIndex - b.barIndex || a.beatInBar - b.beatInBar || a.note.voice - b.note.voice);
  return {
    index: systemIndex,
    startBar: measures[0]?.bar ?? 1,
    endBar: measures[measures.length - 1]?.bar ?? 1,
    bars,
    notes: positioned,
  };
}

/**
 * Pure geometry for one system/window. Kept for the default short fixture and
 * the layout tests; the full score uses layoutScoreSystems below.
 */
export function layoutScore(
  notes: readonly ScoreNote[],
  barCount = 2,
  beatsPerBar: number = STAFF_GEOMETRY.beatsPerBar,
  window?: ScoreLayoutWindow,
  measures?: readonly ScoreMeasureMeta[],
): ScoreLayout {
  const safeBarCount = Math.max(1, barCount);
  const resolved = resolveMeasures(safeBarCount, beatsPerBar, measures);
  const windowStart = Math.min(Math.max(1, window?.startBar ?? 1), safeBarCount);
  const visibleBarCount = Math.max(1, Math.min(
    window?.barCount ?? safeBarCount,
    safeBarCount - windowStart + 1,
  ));
  const system = layoutSystem(
    notes,
    resolved.slice(windowStart - 1, windowStart - 1 + visibleBarCount),
    0,
  );
  return {
    bars: system.bars,
    notes: system.notes,
    unsupported: getUnsupportedNotes(notes, safeBarCount),
  };
}

/**
 * Full score → stacked system rows, like a PDF page. The XML's measure
 * durations determine bar widths; no row assumes 4/4. Four bars per row by
 * default (the PDF reference), with an optional note budget for callers that
 * prefer density-based grouping.
 */
export function layoutScoreSystems(
  notes: readonly ScoreNote[],
  barCount: number,
  beatsPerBar: number = STAFF_GEOMETRY.beatsPerBar,
  options: ScoreSystemsOptions = {},
): ScoreSystemsLayout {
  const safeBarCount = Math.max(1, barCount);
  const resolved = resolveMeasures(safeBarCount, beatsPerBar, options.measures);
  const maxBars = Math.max(1, Math.floor(options.barsPerSystem ?? 4));
  const noteBudget = options.notesPerSystem === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(8, Math.floor(options.notesPerSystem));
  const noteCountByBar = new Map<number, number>();
  for (const note of notes) {
    noteCountByBar.set(note.bar, (noteCountByBar.get(note.bar) ?? 0) + 1);
  }

  const systems: ScoreSystemLayout[] = [];
  let start = 0;
  while (start < resolved.length) {
    let end = start;
    let accumulated = 0;
    while (end < resolved.length && end - start < maxBars) {
      const barNotes = noteCountByBar.get(resolved[end].bar) ?? 0;
      if (end > start && accumulated + barNotes > noteBudget) break;
      accumulated += barNotes;
      end += 1;
    }
    systems.push(layoutSystem(notes, resolved.slice(start, end), systems.length, options.barWidth));
    start = end;
  }
  return {
    systems,
    notes: systems.flatMap((system) => system.notes),
    unsupported: getUnsupportedNotes(notes, safeBarCount),
  };
}

export function buildScoreViewModel(
  notes: readonly ScoreNote[],
  options: ScoreDisplayOptions,
  barCount = 2,
  beatsPerBar: number = STAFF_GEOMETRY.beatsPerBar,
  window?: ScoreLayoutWindow,
  measures?: readonly ScoreMeasureMeta[],
): ScoreViewModel {
  const layout = layoutScore(notes, barCount, beatsPerBar, window, measures);
  return {
    bars: layout.bars,
    unsupported: layout.unsupported,
    notes: layout.notes.map((note) => ({
      ...note,
      showNoteName: options.showNoteNames,
      showPositionHint: options.showPositionHints,
    })),
  };
}

export function buildScoreSystemsViewModel(
  notes: readonly ScoreNote[],
  options: ScoreDisplayOptions,
  barCount: number,
  beatsPerBar: number = STAFF_GEOMETRY.beatsPerBar,
  systemsOptions: ScoreSystemsOptions = {},
): ScoreSystemsViewModel {
  const layout = layoutScoreSystems(notes, barCount, beatsPerBar, systemsOptions);
  const viewNote = (note: PositionedScoreNote): ScoreNoteViewModel => ({
    ...note,
    showNoteName: options.showNoteNames,
    showPositionHint: options.showPositionHints,
  });
  return {
    systems: layout.systems.map((system) => ({
      ...system,
      notes: system.notes.map(viewNote),
    })),
    unsupported: layout.unsupported,
  };
}

export function durationLabel(note: ScoreNote): string {
  if (note.noteType === 'whole') return '全音符';
  if (note.noteType === 'half') return '二分音符';
  if (note.noteType === 'eighth') return '八分音符';
  if (note.noteType === '16th') return '十六分音符';
  return '四分音符';
}

export function beatPositionLabel(
  note: ScoreNote,
  beatsPerBar: number = STAFF_GEOMETRY.beatsPerBar,
  measures?: readonly ScoreMeasureMeta[],
): string {
  const measure = measures?.find((entry) => entry.bar === note.bar);
  const startBeat = measure?.startBeat ?? (note.bar - 1) * beatsPerBar;
  const offset = Math.max(0, note.beat - startBeat);
  const beats = measure?.beats ?? beatsPerBar;
  const beatType = measure?.beatType ?? 4;
  // Compound meters (6/8, 9/8, 12/8) count dotted-quarter beats; simple meters
  // count the notated beat unit (e.g. 3/4 → quarter, 3/8 → eighth).
  const compound = beatType === 8 && beats % 3 === 0 && beats > 3;
  const beatUnit = compound ? 1.5 : 4 / beatType;
  const beat = offset / beatUnit + 1;
  const beatText = Number.isInteger(beat) ? String(beat) : beat.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `第 ${note.bar} 小节 · 第 ${beatText} 拍`;
}
