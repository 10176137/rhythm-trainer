// Explicit layout model for the engraved score.
//
// The score is ONE continuous strip in reading order. Systems (line wraps)
// exist only because a page row cannot hold everything; they must never decide
// what the loop range IS. A range is the segment between two notes in that
// strip, and the band is painted through every system the segment crosses:
// first system from the start note to its right edge, middle systems fully,
// last system from its left edge to the end note.
//
// The staff lines give the vertical system extents deterministically: for a
// piano score, every `stavesPerSystem` consecutive staff lines form exactly one
// system, in document order. Systems never overlap vertically, so a note's
// system is decided by its y position — used only to paint, never to pick the
// range.

export interface StaffSystem {
  /** 0-based index in document order. */
  index: number;
  /** Root-relative coordinates. */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface BandBox {
  system: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Groups staff-line rects (document order, root-relative) into systems. */
export function groupSystems(stafflines: readonly RectLike[], stavesPerSystem: number): StaffSystem[] {
  const per = Math.max(1, Math.floor(stavesPerSystem));
  const ordered = [...stafflines].sort((a, b) => a.top - b.top || a.left - b.left);
  const systems: StaffSystem[] = [];
  for (let i = 0; i < ordered.length; i += per) {
    const group = ordered.slice(i, i + per);
    if (!group.length) continue;
    systems.push({
      index: systems.length,
      top: Math.min(...group.map((rect) => rect.top)),
      bottom: Math.max(...group.map((rect) => rect.bottom)),
      left: Math.min(...group.map((rect) => rect.left)),
      right: Math.max(...group.map((rect) => rect.right)),
    });
  }
  return systems;
}

/** ARRAY POSITION of the system containing the vertical centre of a rect;
 * null when nothing matches. Callers that slice/re-index a system list (the
 * loop band feeds a row window) must be able to index the list they passed in,
 * so this returns the position, never `system.index`. */
export function systemIndexOfRect(systems: readonly StaffSystem[], rect: RectLike): number | null {
  const center = (rect.top + rect.bottom) / 2;
  for (let position = 0; position < systems.length; position += 1) {
    const system = systems[position];
    if (center >= system.top - 12 && center <= system.bottom + 12) return position;
  }
  return null;
}

/**
 * The loop band for a note-level range:
 *   same system      → one box from the start note to the end note
 *   different system → first box to that system's right edge, middle systems
 *                      fully covered, last box from that system's left edge
 * Pure; the component only feeds it measured rects. Positions are array
 * positions, so a sliced/re-indexed row window works too; `BandBox.system`
 * keeps the document row index for stable keys.
 */
export function loopBandBoxes(
  systems: readonly StaffSystem[],
  start: RectLike,
  end: RectLike,
  options: { padY?: number; padX?: number } = {},
): BandBox[] {
  if (!systems.length) return [];
  const padY = options.padY ?? 6;
  const padX = options.padX ?? 4;
  const startPosition = systemIndexOfRect(systems, start);
  const endPosition = systemIndexOfRect(systems, end);
  if (startPosition === null || endPosition === null) return [];
  // Normalise: the band must run from the earlier system to the later one, no
  // matter which note the user tapped first.
  const first = Math.min(startPosition, endPosition);
  const last = Math.max(startPosition, endPosition);
  const from = startPosition <= endPosition ? start : end;
  const to = startPosition <= endPosition ? end : start;

  // Ordered so the band always runs left-to-right across systems.
  const boxes: BandBox[] = [];
  for (let position = first; position <= last; position += 1) {
    const system = systems[position];
    if (!system) continue;
    const left = position === first ? from.left - padX : system.left - padX;
    const right = position === last ? to.right + padX : system.right + padX;
    boxes.push({
      system: system.index,
      left,
      top: system.top - padY,
      width: Math.max(12, right - left),
      height: system.bottom - system.top + padY * 2,
    });
  }
  return boxes;
}

/** A boundary handle's grab geometry: a vertical bar at `left`, spanning
 * `top .. top + height` (root-relative). */
export interface LoopEdgeHandle {
  left: number;
  top: number;
  height: number;
}

/**
 * Which edge a grab anywhere on the band body should drag. The band is one
 * strip in reading order, so B can sit to the LEFT of A in page x when the
 * strip wraps to the next line; an x-midpoint would then hand a grab near B
 * to A. The only wrap-safe choice is the pointer's distance to each handle's
 * vertical bar.
 */
export function nearestLoopEdge(
  pointer: { x: number; y: number },
  start: LoopEdgeHandle,
  end: LoopEdgeHandle,
): 'start' | 'end' {
  const distanceTo = (handle: LoopEdgeHandle) => {
    const dx = pointer.x - handle.left;
    const dy = pointer.y < handle.top
      ? handle.top - pointer.y
      : pointer.y > handle.top + handle.height
        ? pointer.y - (handle.top + handle.height)
        : 0;
    return Math.hypot(dx, dy);
  };
  return distanceTo(start) <= distanceTo(end) ? 'start' : 'end';
}

/**
 * The engraved page is a fixed grid: `measuresPerSystem` measures per row, with
 * the importer padding the last row. The loop contract must NOT use this:
 * a range is one segment of the score's reading order, and systems are only
 * the line wrapping it is painted through. Kept for engraving diagnostics.
 */
export function gridCellOfMeasure(
  measureOrdinal: number,
  measuresPerSystem: number,
): { row: number; column: number } {
  const per = Math.max(1, Math.floor(measuresPerSystem));
  const index = Math.max(0, Math.floor(measureOrdinal) - 1);
  return { row: Math.floor(index / per), column: index % per };
}
