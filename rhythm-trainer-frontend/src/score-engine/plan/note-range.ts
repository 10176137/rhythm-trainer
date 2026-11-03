// Display-only loop picking, boundary persistence and muted-note selection.
// Canonical score refinement and tie handling live in server/plan-note-range.mjs.
import type { LoopBoundaryNote } from '../../types/practice';
import type { ScoreDocument, ScoreEvent } from '../domain/types';
import { beatToString, compareBeat, rational, toNumber, type RationalBeat } from '../domain/rational';

export interface NoteRange {
  /** The earlier event by absolute onset. */
  start: LoopBoundaryNote;
  /** The later event by absolute onset. */
  end: LoopBoundaryNote;
}

/** Serializes an engine event into the persisted boundary shape. */
export function boundaryFromEvent(event: ScoreEvent): LoopBoundaryNote {
  return {
    eventId: event.id,
    measureOrdinal: event.source.measureOrdinal,
    onsetBeat: beatToString(event.onsetBeat),
  };
}

function onsetOf(boundary: LoopBoundaryNote): RationalBeat {
  const [numerator, denominator] = boundary.onsetBeat.split('/').map(Number);
  return rational(numerator, denominator);
}

/** Orders two tapped boundaries by absolute onset, regardless of tap order. */
export function normalizeNoteRange(a: LoopBoundaryNote, b: LoopBoundaryNote): NoteRange {
  const measureDelta = a.measureOrdinal - b.measureOrdinal;
  const onsetDelta = measureDelta !== 0 ? measureDelta : compareBeat(onsetOf(a), onsetOf(b));
  return onsetDelta <= 0 ? { start: a, end: b } : { start: b, end: a };
}

/** Finds the tapped event in the document; a boundary from another score (or a
 * stale persistence) resolves to null and the caller falls back to bar-level. */
export function resolveBoundaryEvent(score: ScoreDocument, boundary: LoopBoundaryNote | null | undefined): ScoreEvent | null {
  if (!boundary) return null;
  const event = resolveEventById(score, boundary.eventId);
  return event && event.source.measureOrdinal === boundary.measureOrdinal ? event : null;
}

/** Plain id lookup (no measure cross-check) for freshly tapped events. */
export function resolveEventById(score: ScoreDocument, eventId: string): ScoreEvent | null {
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const event of measure.events) {
        if (event.id === eventId) return event;
      }
    }
  }
  return null;
}

/** Both boundaries must resolve inside the same score for a note-level range. */
export function resolveNoteRange(score: ScoreDocument, start: LoopBoundaryNote | null | undefined, end: LoopBoundaryNote | null | undefined): NoteRange | null {
  const startEvent = resolveBoundaryEvent(score, start);
  const endEvent = resolveBoundaryEvent(score, end);
  if (!startEvent || !endEvent) return null;
  return normalizeNoteRange(boundaryFromEvent(startEvent), boundaryFromEvent(endEvent));
}

function inOnsetWindow(onset: RationalBeat, range: NoteRange): boolean {
  return compareBeat(onset, onsetOf(range.start)) >= 0 && compareBeat(onset, onsetOf(range.end)) <= 0;
}

/** Whole-score boundaries: first and last playable note events. Used when the
 * loop is switched ON without prior boundaries, so the first handle drag has a
 * valid opposite end to span from. */
export function wholeScoreBoundaries(score: ScoreDocument): NoteRange | null {
  let first: ScoreEvent | null = null;
  let last: ScoreEvent | null = null;
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const event of measure.events) {
        if (event.kind !== 'note' || event.isGrace || event.isCue) continue;
        if (!first || compareBeat(event.onsetBeat, first.onsetBeat) < 0) first = event;
        if (!last || compareBeat(event.onsetBeat, last.onsetBeat) > 0) last = event;
      }
    }
  }
  if (!first || !last) return null;
  return normalizeNoteRange(boundaryFromEvent(first), boundaryFromEvent(last));
}

/**
 * Event ids of playable note events OUTSIDE the note range, in the same order
 * (measure ordinal → onset → source order) the planner walks the score. Drives
 * the display muting and the launch-scope filters so what the user sees is
 * exactly what the trimmed plan will contain.
 */
export function loopRangeMutedEventIds(score: ScoreDocument, range: NoteRange): Set<string> {
  const kept = new Set<string>();
  for (const part of score.parts) {
    for (const measure of part.measures) {
      if (measure.ordinal < range.start.measureOrdinal || measure.ordinal > range.end.measureOrdinal) continue;
      const isEdge = measure.ordinal === range.start.measureOrdinal || measure.ordinal === range.end.measureOrdinal;
      for (const event of measure.events) {
        if (event.kind !== 'note' || event.isGrace || event.isCue) continue;
        if (!isEdge || inOnsetWindow(event.onsetBeat, range)) kept.add(event.id);
      }
    }
  }
  const muted = new Set<string>();
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const event of measure.events) {
        if (event.kind !== 'note' || event.isGrace || event.isCue) continue;
        if (!kept.has(event.id)) muted.add(event.id);
      }
    }
  }
  return muted;
}

/**
 * A tap lands on one chord member's event id; a chord is one musical onset, so
 * the range picker canonicalizes to the member with the lowest source ordinal.
 * Returns null when the id does not resolve in this score.
 */
export function canonicalLoopPickEventId(score: ScoreDocument, eventId: string): string | null {
  let tapped: ScoreEvent | null = null;
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const event of measure.events) {
        if (event.id === eventId) { tapped = event; break; }
      }
      if (tapped) break;
    }
    if (tapped) break;
  }
  if (!tapped) return null;
  if (!tapped.chordGroupId) return tapped.id;
  let canonical: ScoreEvent | null = null;
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const event of measure.events) {
        if (event.chordGroupId !== tapped.chordGroupId) continue;
        if (!canonical || event.source.sourceOrdinal < canonical.source.sourceOrdinal) canonical = event;
      }
    }
  }
  return canonical?.id ?? tapped.id;
}

/** Default loop window when the user switches the loop on without a prior
 * choice: the first `measureCount` measures (one engraved row), not the whole
 * score — a whole-score default highlights everything and reads as a bug. */
export function defaultLoopBoundaries(score: ScoreDocument, measureCount = 4): NoteRange | null {
  let first: ScoreEvent | null = null;
  let last: ScoreEvent | null = null;
  for (const part of score.parts) {
    for (const measure of part.measures) {
      if (measure.ordinal > measureCount) continue;
      for (const event of measure.events) {
        if (event.kind !== 'note' || event.isGrace || event.isCue) continue;
        if (!first) first = event;
        last = event;
      }
    }
  }
  if (!first || !last) return wholeScoreBoundaries(score);
  return normalizeNoteRange(boundaryFromEvent(first), boundaryFromEvent(last));
}

/** Orders two boundaries by absolute onset (measure, then beat). */
export function compareBoundaryOnset(a: LoopBoundaryNote, b: LoopBoundaryNote): number {
  if (a.measureOrdinal !== b.measureOrdinal) return a.measureOrdinal - b.measureOrdinal;
  return compareBeat(onsetOf(a), onsetOf(b));
}

/**
 * Which endpoint a tap should move: the one nearest the tapped onset in the
 * score's reading order. Outside the range the side decides (so a one-note
 * range can grow in either direction instead of clamping onto itself); inside
 * a tie moves the start.
 */
export function loopBoundaryForTap(
  startOnset: RationalBeat,
  endOnset: RationalBeat,
  tappedOnset: RationalBeat,
): 'start' | 'end' {
  const start = toNumber(startOnset);
  const end = toNumber(endOnset);
  const tapped = toNumber(tappedOnset);
  if (tapped < start) return 'start';
  if (tapped > end) return 'end';
  return tapped - start <= end - tapped ? 'start' : 'end';
}

/**
 * Dragging one edge must never move the other one. When the dragged edge is
 * pulled past its partner, clamp it onto that partner instead of swapping the
 * two ends (a swap made the untouched handle jump to the cursor).
 */
export function clampDraggedBoundary(
  which: 'start' | 'end',
  dragged: LoopBoundaryNote,
  fixed: LoopBoundaryNote,
): { start: LoopBoundaryNote; end: LoopBoundaryNote } {
  if (which === 'start') {
    return compareBoundaryOnset(dragged, fixed) <= 0
      ? { start: dragged, end: fixed }
      : { start: fixed, end: fixed };
  }
  return compareBoundaryOnset(dragged, fixed) >= 0
    ? { start: fixed, end: dragged }
    : { start: fixed, end: fixed };
}
