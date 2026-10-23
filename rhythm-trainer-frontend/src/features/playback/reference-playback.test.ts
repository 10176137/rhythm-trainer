import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importMusicXml } from '../../score-engine/import/musicxml-importer';
import { buildPlaybackPlan } from '../../score-engine/playback/playback-planner';
import {
  buildReferencePlaybackPlan,
  validateReferencePlanAgainstTargets,
  type ReferencePlaybackNote,
  type ReferencePlaybackPlan,
  type ReferencePlaybackVoice,
} from '../../score-engine/playback/reference-playback-plan';
import { toLegacyScoreDocument } from '../../score-engine/legacy-bridge';
import { ReferencePlaybackController } from './reference-playback-controller';
import type { PlaybackAudioEngine, PlaybackVoiceSpec } from './audioEngineAdapter';

const fixture = (name: string) =>
  readFileSync(new URL(`../../score-engine/test/fixtures/${name}`, import.meta.url), 'utf8');

function fixturePlan(name: string, hand: 'both' | 'left' | 'right' = 'both') {
  const imported = importMusicXml(fixture(name), { fileName: name });
  if (!imported.scoreDocument) throw new Error(`fixture ${name} did not import`);
  const legacy = toLegacyScoreDocument(imported.scoreDocument, imported.importReport, name);
  const handByScoreEventId = new Map(legacy.notes.map((note) => [note.id, note.hand] as const));
  const measures = Math.max(...imported.scoreDocument.parts.map((part) => part.measures.length));
  const source = buildPlaybackPlan(imported.scoreDocument, {
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: measures },
    repeatSelection: { kind: 'none' },
    unsupportedNotationPolicy: 'reject-strict',
  });
  if (!source.plan) throw new Error(`fixture ${name} has no playback plan`);
  return {
    doc: imported.scoreDocument,
    legacy,
    sourcePlan: source.plan,
    result: buildReferencePlaybackPlan(source.plan, {
      bpm: 80,
      countInBeats: 4,
      hand,
      handByScoreEventId,
    }),
  };
}

class FakeAudio implements PlaybackAudioEngine {
  time = 0;
  stateValue: AudioContextState | 'unknown' = 'running';
  prepared = 0;
  gain = 1;
  noteOns: { voice: PlaybackVoiceSpec; at: number }[] = [];
  noteOffs: { voiceId: string; at: number }[] = [];
  allNotesOffCalls: { reason: string; at?: number }[] = [];

  async prepare(): Promise<void> {
    this.prepared += 1;
    if (this.stateValue !== 'running') throw new Error('audio suspended');
  }

  scheduleNoteOn(voice: PlaybackVoiceSpec, atAudioTime: number): void {
    if (this.stateValue !== 'running') throw new Error('audio suspended');
    this.noteOns.push({ voice, at: atAudioTime });
  }

  scheduleNoteOff(voiceId: string, atAudioTime: number): void {
    this.noteOffs.push({ voiceId, at: atAudioTime });
  }

  allNotesOff(reason: string, atAudioTime?: number): void {
    this.allNotesOffCalls.push({ reason, at: atAudioTime });
  }

  setGain(value: number): void {
    this.gain = value;
  }

  currentTime(): number {
    return this.time;
  }

  state(): AudioContextState | 'unknown' {
    return this.stateValue;
  }

  dispose(): void {
    this.noteOns = [];
    this.noteOffs = [];
  }

  advance(ms: number): void {
    this.time += ms / 1000;
  }
}

function voice(id: string, midiNote: number, atMs: number, durationMs = 500): ReferencePlaybackVoice {
  return {
    voiceId: id,
    occurrenceId: id,
    scoreEventId: id,
    midiNote,
    velocity: 0.7,
    atMs,
    durationMs,
  };
}

function note(eventId: string, atMs: number, voices: ReferencePlaybackVoice[]): ReferencePlaybackNote {
  const durationMs = Math.max(...voices.map((item) => item.durationMs));
  return {
    eventId,
    groupId: eventId,
    occurrenceIds: voices.map((item) => item.occurrenceId),
    scoreEventIds: voices.map((item) => item.scoreEventId),
    atMs,
    durationMs,
    bar: 1,
    beat: 1,
    staffNumbers: [1],
    voiceIds: voices.map((item) => item.occurrenceId),
    activeScoreEventIds: voices.map((item) => item.scoreEventId),
    voices,
  };
}

function testPlan(notes: ReferencePlaybackNote[], countInMs = 1000): ReferencePlaybackPlan {
  return {
    planId: 'test-plan',
    sourcePlanId: 'test-plan',
    scoreFingerprint: 'test-fingerprint',
    bpm: 60,
    countInMs,
    hand: 'both',
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: 1 },
    notes,
    lastEndMs: Math.max(...notes.map((item) => item.atMs + item.durationMs)),
    issues: [],
    strictAllowed: true,
  };
}

function targetsFor(plan: ReferencePlaybackPlan) {
  return plan.notes.map((item) => ({ atMs: item.atMs, bar: item.bar }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reference playback plan', () => {
  it('keeps count-in, target time and voice duration from the shared plan', () => {
    const { result } = fixturePlan('piano-two-staff-basic.musicxml');
    expect(result.plan).toBeDefined();
    expect(result.plan!.countInMs).toBe(3000);
    expect(result.plan!.notes.length).toBeGreaterThan(0);
    expect(result.plan!.notes[0].atMs).toBeGreaterThanOrEqual(3000);
    expect(result.plan!.notes.every((item) => item.voices.length > 0)).toBe(true);
    expect(result.plan!.notes.some((item) => item.durationMs > 1200)).toBe(true);
    // Same onset, different written durations: the right-hand quarter note must
    // not inherit the left-hand half note's longer group duration. This is the
    // same class of bug as a sustained treble chord over a moving short bass
    // line (e.g. 晓之车 measure 23).
    const first = result.plan!.notes.find((item) => Math.abs(item.atMs - 3000) < 1);
    expect(first).toBeDefined();
    expect(first!.voices.map((item) => Math.round(item.durationMs)).sort((a, b) => a - b)).toEqual([750, 1500]);
  });

  it('filters target groups and voices by hand before atoms are built', () => {
    const both = fixturePlan('piano-two-staff-basic.musicxml', 'both');
    const right = fixturePlan('piano-two-staff-basic.musicxml', 'right');
    const left = fixturePlan('piano-two-staff-basic.musicxml', 'left');
    expect(right.result.plan).toBeDefined();
    expect(left.result.plan).toBeDefined();
    expect(left.result.plan!.notes.length).toBeLessThan(both.result.plan!.notes.length);
    const rightVoices = right.result.plan!.notes.flatMap((item) => item.voices);
    const leftVoices = left.result.plan!.notes.flatMap((item) => item.voices);
    expect(rightVoices).toHaveLength(8);
    expect(leftVoices).toHaveLength(4);

    const rightIds = new Set(right.result.plan!.notes.flatMap((item) => item.voices.map((v) => v.scoreEventId)));
    const leftIds = new Set(left.result.plan!.notes.flatMap((item) => item.voices.map((v) => v.scoreEventId)));
    for (const id of rightIds) expect(both.legacy.notes.find((item) => item.id === id)?.hand).toBe('right');
    for (const id of leftIds) expect(both.legacy.notes.find((item) => item.id === id)?.hand).toBe('left');
    expect([...rightIds].some((id) => leftIds.has(id))).toBe(false);
    expect(right.result.scopedPlan!.planId).toContain(':hand=right');
  });

  it('keeps chord voices at one onset and excludes tie continuations', () => {
    const chord = fixturePlan('triad-chord.musicxml');
    const chordNote = chord.result.plan!.notes.find((item) => item.voices.length === 3);
    expect(chordNote).toBeDefined();
    expect(new Set(chordNote!.voices.map((v) => v.atMs))).toEqual(new Set([chordNote!.atMs]));

    const tied = fixturePlan('tie-across-measure.musicxml');
    const continuationIds = new Set(tied.doc.tieSpans.flatMap((span) => span.eventIds.slice(1)));
    const playedIds = new Set(tied.result.plan!.notes.flatMap((item) => item.voices.map((v) => v.scoreEventId)));
    expect([...continuationIds].some((id) => playedIds.has(id))).toBe(false);
  });

  it('validates the engine target contract', () => {
    const { result } = fixturePlan('piano-two-staff-basic.musicxml');
    const plan = result.plan!;
    expect(validateReferencePlanAgainstTargets(plan, targetsFor(plan))).toEqual([]);
    const shifted = targetsFor(plan);
    shifted[0] = { ...shifted[0], atMs: shifted[0].atMs + 10 };
    expect(validateReferencePlanAgainstTargets(plan, shifted).length).toBeGreaterThan(0);
  });
});

describe('reference playback controller', () => {
  it('schedules note on/off on the audio clock and uses the target duration', async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const plan = testPlan([
      note('n1', 1000, [voice('v1', 60, 1000, 500)]),
      note('n2', 1500, [voice('v2', 62, 1500, 250)]),
    ]);
    const controller = new ReferencePlaybackController({ audio });
    await controller.start(plan, { engineTargets: targetsFor(plan) });
    expect(controller.getSnapshot().status).toBe('COUNT_IN');

    audio.advance(1000);
    vi.advanceTimersByTime(25);
    expect(controller.getSnapshot().status).toBe('PLAYING');
    expect(audio.noteOns.map((item) => item.voice.voiceId)).toEqual(['v1']);
    expect(audio.noteOns[0].at).toBeCloseTo(1.0, 3);
    expect(audio.noteOffs[0].at).toBeCloseTo(1.5, 3);

    audio.advance(500);
    vi.advanceTimersByTime(25);
    expect(audio.noteOns.map((item) => item.voice.voiceId)).toEqual(['v1', 'v2']);
    expect(audio.noteOffs[1].at).toBeCloseTo(1.75, 3);

    controller.dispose();
  });

  it('schedules each chord voice with its own duration', async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const plan = testPlan([
      note('chord', 1000, [
        voice('long', 60, 1000, 1000),
        voice('short', 64, 1000, 250),
      ]),
    ]);
    const controller = new ReferencePlaybackController({ audio });
    await controller.start(plan, { engineTargets: targetsFor(plan) });
    audio.advance(1000);
    vi.advanceTimersByTime(25);

    expect(audio.noteOns.map((item) => item.voice.voiceId).sort()).toEqual(['long', 'short']);
    const longOff = audio.noteOffs.find((item) => item.voiceId === 'long');
    const shortOff = audio.noteOffs.find((item) => item.voiceId === 'short');
    expect(longOff?.at).toBeCloseTo(2.0, 3);
    expect(shortOff?.at).toBeCloseTo(1.25, 3);
    controller.dispose();
  });

  it('stops future sound on pause and resumes from the paused position', async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const plan = testPlan([
      note('n1', 1000, [voice('v1', 60, 1000, 500)]),
      note('n2', 1500, [voice('v2', 62, 1500, 500)]),
    ]);
    const controller = new ReferencePlaybackController({ audio });
    await controller.start(plan, { engineTargets: targetsFor(plan) });
    audio.advance(1000);
    vi.advanceTimersByTime(25);
    expect(audio.noteOns).toHaveLength(1);

    controller.pause('test');
    const paused = controller.getSnapshot();
    expect(paused.status).toBe('PAUSED');
    expect(audio.allNotesOffCalls.some((item) => item.reason.includes('pause:test'))).toBe(true);
    audio.advance(1000);
    vi.advanceTimersByTime(25);
    expect(audio.noteOns).toHaveLength(1);
    expect(controller.getSnapshot().positionMs).toBeCloseTo(paused.positionMs, 3);

    await controller.resume();
    expect(controller.getSnapshot().status).toBe('PLAYING');
    audio.advance(500);
    vi.advanceTimersByTime(25);
    expect(audio.noteOns.map((item) => item.voice.voiceId)).toEqual(['v1', 'v2']);

    controller.stop('test-done');
    expect(controller.getSnapshot().status).toBe('STOPPED');
    expect(audio.allNotesOffCalls.some((item) => item.reason.includes('stop:test-done'))).toBe(true);
    controller.dispose();
  });

  it('reports underrun instead of silently dropping late notes', async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const plan = testPlan([
      note('n1', 1000, [voice('v1', 60, 1000, 200)]),
      note('n2', 1500, [voice('v2', 62, 1500, 200)]),
    ]);
    const controller = new ReferencePlaybackController({ audio });
    await controller.start(plan, { engineTargets: targetsFor(plan) });
    audio.advance(5000);
    vi.advanceTimersByTime(25);

    expect(controller.getSnapshot().health).toBe('DEGRADED');
    expect(controller.getDiagnostics().some((item) => item.code === 'reference_playback.scheduler_underrun')).toBe(true);
    expect(audio.noteOns).toHaveLength(0);
    controller.dispose();
  });

  it('fails when the engine target plan does not match', async () => {
    const audio = new FakeAudio();
    const plan = testPlan([note('n1', 1000, [voice('v1', 60, 1000, 500)])]);
    const controller = new ReferencePlaybackController({ audio });
    await controller.start(plan, { engineTargets: [{ atMs: 2000, bar: 1 }] });
    expect(controller.getSnapshot().status).toBe('FAILED');
    expect(controller.getSnapshot().errorCode).toBe('reference_playback.target_plan_mismatch');
    controller.dispose();
  });

  it('pauses visibly when the shared AudioContext is suspended', async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const plan = testPlan([note('n1', 1000, [voice('v1', 60, 1000, 500)])]);
    const controller = new ReferencePlaybackController({ audio });
    await controller.start(plan, { engineTargets: targetsFor(plan) });
    audio.stateValue = 'suspended';
    vi.advanceTimersByTime(25);
    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe('PAUSED');
    expect(snapshot.errorCode).toBe('AUDIO_CONTEXT_SUSPENDED');
    expect(snapshot.health).toBe('DEGRADED');
    controller.dispose();
  });
});
