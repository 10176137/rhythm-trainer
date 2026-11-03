import { describe, expect, it } from 'vitest';
import { gridCellOfMeasure, groupSystems, loopBandBoxes, nearestLoopEdge, systemIndexOfRect, type RectLike } from './score-layout';

// Measured geometry from the real engraved score (root-relative staff lines).
const STAFFLINES: RectLike[] = [
  { top: 41, bottom: 123, left: 20, right: 720 },
  { top: 86, bottom: 189, left: 20, right: 720 },
  { top: 214, bottom: 265, left: 20, right: 720 },
  { top: 225, bottom: 324, left: 20, right: 720 },
  { top: 348, bottom: 394, left: 20, right: 720 },
  { top: 357, bottom: 460, left: 20, right: 720 },
];

const SYSTEMS = groupSystems(STAFFLINES, 2);

function note(top: number, left: number) {
  return { top, bottom: top + 10, left, right: left + 12 };
}

describe('score layout model', () => {
  it('builds one system per staff pair, in document order', () => {
    expect(SYSTEMS).toEqual([
      { index: 0, top: 41, bottom: 189, left: 20, right: 720 },
      { index: 1, top: 214, bottom: 324, left: 20, right: 720 },
      { index: 2, top: 348, bottom: 460, left: 20, right: 720 },
    ]);
  });

  it('resolves a note to the system that contains it', () => {
    expect(systemIndexOfRect(SYSTEMS, note(100, 300))).toBe(0); // treble staff of system 0
    expect(systemIndexOfRect(SYSTEMS, note(170, 300))).toBe(0); // bass staff of system 0
    expect(systemIndexOfRect(SYSTEMS, note(240, 300))).toBe(1);
    expect(systemIndexOfRect(SYSTEMS, note(400, 300))).toBe(2);
  });

  it('draws ONE box inside a system, from the start note to the end note', () => {
    const boxes = loopBandBoxes(SYSTEMS, note(170, 300), note(170, 500));
    expect(boxes).toHaveLength(1);
    expect(boxes[0].top).toBe(41 - 6);
    expect(boxes[0].height).toBe(189 - 41 + 12);
    expect(boxes[0].left).toBe(300 - 4);
    expect(boxes[0].width).toBe(500 + 12 - 300 + 8);
  });

  it('never spills into the next system (the reported bug)', () => {
    const boxes = loopBandBoxes(SYSTEMS, note(170, 300), note(170, 500));
    const bottom = boxes[0].top + boxes[0].height;
    expect(bottom).toBeLessThan(214); // next system starts at 214
  });

  it('covers intermediate systems when the range crosses rows', () => {
    const boxes = loopBandBoxes(SYSTEMS, note(100, 300), note(400, 500));
    expect(boxes).toHaveLength(3);
    // first: start note → right edge of its system
    expect(boxes[0].left).toBe(300 - 4);
    expect(boxes[0].left + boxes[0].width).toBe(720 + 4);
    // middle: whole system
    expect(boxes[1].left).toBe(20 - 4);
    expect(boxes[1].left + boxes[1].width).toBe(720 + 4);
    // last: left edge of its system → end note
    expect(boxes[2].left).toBe(20 - 4);
    expect(boxes[2].left + boxes[2].width).toBe(500 + 12 + 4);
  });

  it('works on a sliced/re-indexed row window (supported input shape)', () => {
    // The loop no longer slices rows, but a caller may pass a window whose
    // indices are DOCUMENT rows. The band must index the list it was given,
    // not `system.index` (off-by-firstRow drew the first segment on the next
    // row and dropped the last one).
    const window = SYSTEMS.slice(1, 3).map((system, index) => ({ ...system, index: 1 + index }));
    const boxes = loopBandBoxes(window, note(240, 300), note(400, 500));
    expect(boxes).toHaveLength(2);
    expect(boxes[0].system).toBe(1);
    expect(boxes[0].left).toBe(300 - 4);
    expect(boxes[0].top).toBe(214 - 6);
    expect(boxes[0].left + boxes[0].width).toBe(720 + 4);
    expect(boxes[1].system).toBe(2);
    expect(boxes[1].left).toBe(20 - 4);
    expect(boxes[1].top).toBe(348 - 6);
    expect(boxes[1].left + boxes[1].width).toBe(500 + 12 + 4);
  });

  it('orders a backwards range so the band still runs forward', () => {
    const boxes = loopBandBoxes(SYSTEMS, note(400, 500), note(100, 300));
    expect(boxes).toHaveLength(3);
    expect(boxes[0].left).toBe(300 - 4);
    expect(boxes[2].left + boxes[2].width).toBe(500 + 12 + 4);
  });

  it('returns nothing when the notes are outside every system', () => {
    expect(loopBandBoxes(SYSTEMS, note(-500, 100), note(-480, 200))).toEqual([]);
  });

  it('picks the edge by handle distance, never by an x midpoint', () => {
    // A on an upper line at x=335; B on the next line at x=265 — in a wrapped
    // strip B is AFTER A but to its LEFT in page x.
    const start = { left: 335, top: 0, height: 100 };
    const end = { left: 265, top: 200, height: 100 };
    expect(nearestLoopEdge({ x: 265, y: 250 }, start, end)).toBe('end');
    expect(nearestLoopEdge({ x: 335, y: 50 }, start, end)).toBe('start');
    // Same x window, different rows: each row's grab belongs to its own edge.
    expect(nearestLoopEdge({ x: 300, y: 50 }, start, end)).toBe('start');
    expect(nearestLoopEdge({ x: 300, y: 250 }, start, end)).toBe('end');
  });

  it('maps a measure ordinal to a grid cell (engraving diagnostics only)', () => {
    expect(gridCellOfMeasure(1, 4)).toEqual({ row: 0, column: 0 });
    expect(gridCellOfMeasure(4, 4)).toEqual({ row: 0, column: 3 });
    expect(gridCellOfMeasure(5, 4)).toEqual({ row: 1, column: 0 });
    expect(gridCellOfMeasure(9, 4)).toEqual({ row: 2, column: 0 });
    expect(gridCellOfMeasure(72, 4)).toEqual({ row: 17, column: 3 });
  });
});
