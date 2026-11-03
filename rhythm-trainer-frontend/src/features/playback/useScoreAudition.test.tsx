// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { importMusicXml } from '../../score-engine/import/musicxml-importer';
import { boundaryFromEvent, wholeScoreBoundaries } from '../../score-engine/plan/note-range';
import { defaultPracticeSettings } from '../practice/practiceSettings';
// @ts-expect-error Native Node service is exercised directly by this integration test.
import { createPlannerService } from '../../../server/planner-service.mjs';
import { useScoreAudition } from './useScoreAudition';
import type { ReferencePlaybackPlan } from '../../score-engine/playback/reference-playback-plan';
import type { PlanRequestInput } from '../../services/engineBridge';
import type { RustPlanResponse } from '../../score-engine/plan/rust-plan';

const audio = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('./sharedAudioContext', () => ({ ensureSharedAudioContext: vi.fn().mockResolvedValue({ state: 'running' }) }));
vi.mock('./reference-playback-controller', () => ({ ReferencePlaybackController: class {
  subscribe() { return () => {}; } dispose() {} start = audio.start; stop = audio.stop;
} }));

it('auditions a selected note through real Node/Rust planning and cancels stale playback on a new pick', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const native = createRequire(import.meta.url)('../../../../rhythm-trainer-core-v0.2/bindings/node');
  const service = createPlannerService({ authority: 'rust', nativeModule: native });
  const imported = importMusicXml(readFileSync('src/features/score/fixtures/c-major-practice.musicxml', 'utf8'));
  const score = imported.scoreDocument!;
  const notes = score.parts[0].measures.flatMap(m => m.events).filter(e => e.kind === 'note');
  const selected = notes.find(e => e.source.measureOrdinal === 2 && e.source.staffNumber === 1)!;
  const last = wholeScoreBoundaries(score)!.end;
  // Last event in MusicXML source order is a bass note BEFORE the last treble onset.
  expect(last.eventId).not.toBe(notes.at(-1)!.id);
  let config = { ...defaultPracticeSettings.config, playbackStartNote: boundaryFromEvent(selected) };
  const mapping = () => ({ schemaVersion: 1 as const, mappingVersion: 'hand-mapping-1' as const, source: 'user' as const,
    parts: [{ partId: score.parts[0].id, staves: [{ staffNumber: 1, hand: 'right' as const }, { staffNumber: 2, hand: 'left' as const }] }] });
  let resolve!: (value: RustPlanResponse) => void;
  let delayed = false;
  const requestPlan = vi.fn(async (input: PlanRequestInput) => {
    const response = { ...service.buildRustPlan(input), scoreFingerprint: score.fingerprint, requestId: 'audition-test' } as RustPlanResponse;
    return delayed ? new Promise<RustPlanResponse>(r => { resolve = () => r(response); }) : response;
  });
  let audition!: ReturnType<typeof useScoreAudition>;
  function Harness() { audition = useScoreAudition({ enabled: true, score, report: imported.importReport, config, mapping, requestPlan }); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => audition.play());
    expect(audition.error).toBe(''); expect(audio.start).toHaveBeenCalledOnce();
    expect(requestPlan.mock.calls[0][0].noteRange).toEqual({ startEventId: selected.id, endEventId: last.eventId });
    const played = audio.start.mock.calls[0][0] as ReferencePlaybackPlan;
    expect(played.notes[0].scoreEventIds).toContain(selected.id);
    expect(audio.start.mock.calls[0][1].startAtMs).toBe(played.notes[0].atMs);
    expect(played.notes.some(n => n.scoreEventIds.includes(last.eventId))).toBe(true);
    delayed = true; let pending!: Promise<void>;
    await act(async () => { pending = audition.play(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { config = { ...config, playbackStartNote: null as never }; root.render(<Harness />); });
    await act(async () => { resolve({} as RustPlanResponse); await pending; });
    expect(audio.start).toHaveBeenCalledOnce(); expect(audition.active).toBe(false);
    delayed = false; await act(async () => audition.play()); expect(requestPlan.mock.calls.at(-1)![0].noteRange).toBeUndefined();
    expect(audio.start).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
