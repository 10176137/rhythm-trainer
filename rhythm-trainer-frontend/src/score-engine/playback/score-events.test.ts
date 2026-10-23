import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../import/musicxml-importer';
import { buildPlaybackPlan } from './playback-planner';
import { buildEngineScoreEvents } from './score-events';
import type { PlaybackPlan } from '../domain/types';

const fixture = (name: string) =>
  readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8');

function planFor(name: string): PlaybackPlan {
  const result = importMusicXml(fixture(name), { fileName: name });
  if (!result.scoreDocument) throw new Error(`${name} did not import`);
  const measures = Math.max(...result.scoreDocument.parts.map((part) => part.measures.length));
  const resultPlan = buildPlaybackPlan(result.scoreDocument, {
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: measures },
    repeatSelection: { kind: 'none' },
    unsupportedNotationPolicy: 'reject-strict',
  });
  if (!resultPlan.plan) throw new Error(`${name} has no plan`);
  return resultPlan.plan;
}

describe('score event contract', () => {
  it('is per-note, includes count-in, and keeps per-voice durations', () => {
    const plan = planFor('piano-two-staff-basic.musicxml');
    const events = buildEngineScoreEvents(plan, 80, 4);
    expect(events).toHaveLength(plan.occurrences.length);
    expect(events[0].targetOnsetMs).toBeGreaterThanOrEqual(3000);
    const firstOnset = events.filter((event) => Math.abs(event.targetOnsetMs - 3000) < 0.001);
    expect(firstOnset.map((event) => Math.round(event.targetDurationMs)).sort((a, b) => a - b)).toEqual([750, 1500]);
    expect(new Set(events.map((event) => event.scoreEventId)).size).toBe(events.length);
  });

  it('does not create an extra onset for a tie continuation', () => {
    const plan = planFor('tie-across-measure.musicxml');
    const events = buildEngineScoreEvents(plan, 80, 4);
    expect(events).toHaveLength(plan.occurrences.length);
    expect(new Set(events.map((event) => event.scoreEventId)).size).toBe(events.length);
  });

  it('keeps chord notes as separate score events with distinct pitches', () => {
    const plan = planFor('triad-chord.musicxml');
    const events = buildEngineScoreEvents(plan, 80, 4);
    const sameOnset = events.filter((event) => Math.abs(event.targetOnsetMs - events[0].targetOnsetMs) < 0.001);
    expect(sameOnset).toHaveLength(3);
    expect(new Set(sameOnset.map((event) => event.pitch)).size).toBe(3);
  });
});
