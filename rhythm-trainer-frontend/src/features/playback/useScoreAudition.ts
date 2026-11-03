import { useEffect, useRef, useState } from 'react';
import { ReferencePlaybackController } from './reference-playback-controller';
import { WebAudioEngineAdapter } from './audioEngineAdapter';
import { ensureSharedAudioContext } from './sharedAudioContext';
import { buildReferencePlaybackPlan } from '../../score-engine/playback/reference-playback-plan';
import { projectScoreDocumentV1 } from '../../score-engine/contract-v1/plan-fingerprint';
import { assertTimelineResponseUsable, rangeSpanFromDocument, toPlaybackPlan } from '../../score-engine/plan/rust-plan';
import { scoreSelection, scoreSelectionBars } from '../practice/scoreSelection';
import type { ScoreDocument, ImportReport } from '../../score-engine/domain/types';
import type { PracticeConfig } from '../../types/practice';
import type { HandMappingV1 } from '../../score-engine/scope/practice-scope';
import type { PlanRequestInput } from '../../services/engineBridge';
import type { RustPlanResponse } from '../../score-engine/plan/rust-plan';

interface Options {
  enabled: boolean;
  score: ScoreDocument | undefined; report: ImportReport | undefined; config: PracticeConfig;
  mapping: () => HandMappingV1 | null;
  requestPlan: (request: PlanRequestInput) => Promise<RustPlanResponse>;
}
/** Standalone reference playback: reuses the audio controller and Node/Rust
 * plan API, never starts a Take or produces scores/history. */
export function useScoreAudition(options: Options) {
  const current = useRef(options); current.current = options;
  const player = useRef<ReferencePlaybackController | null>(null);
  const generation = useRef(0);
  const [active, setActive] = useState(false);
  const [error, setError] = useState('');
  const [activeNoteIds, setActiveNoteIds] = useState<string[]>([]);
  const stop = () => { generation.current += 1; player.current?.stop('selection-or-user'); setActive(false); setActiveNoteIds([]); };
  useEffect(() => {
    const controller = new ReferencePlaybackController({ audio: new WebAudioEngineAdapter() }); player.current = controller;
    const unsubscribe = controller.subscribe((snapshot) => {
      setActive(['PREPARING', 'COUNT_IN', 'PLAYING'].includes(snapshot.status));
      setActiveNoteIds(snapshot.status === 'PLAYING' ? snapshot.activeScoreEventIds : []);
      if (snapshot.status === 'FAILED') setError('试听播放失败，请检查音频权限后重试。');
    });
    return () => { generation.current += 1; unsubscribe(); controller.dispose(); player.current = null; };
  }, []);
  const key = `${options.enabled}|${options.score?.fingerprint ?? ''}|${JSON.stringify(options.config)}`;
  useEffect(() => { stop(); setError(''); }, [key]);
  async function play() {
    if (!current.current.enabled) return;
    stop(); setError(''); setActive(true);
    const version = generation.current;
    try {
      // Prime audio inside this click, before waiting for Node.
      await ensureSharedAudioContext();
      if (version !== generation.current) return;
      const { score, report, config, mapping, requestPlan } = current.current;
      if (!score || !report) throw new Error('当前曲谱没有可用的语义数据。');
      const hands = mapping(); if (!hands) throw new Error('请先在设置中确认当前曲谱的手别。');
      const range = scoreSelectionBars(score, config, score.parts[0].measures.length);
      const notes = scoreSelection(score, config);
      const projected = projectScoreDocumentV1(score, report);
      if (projected.issues.length) throw new Error('当前曲谱不能生成试听计划。');
      const response = await requestPlan({ document: projected.dto, report, mode: 'timeline', scoreFingerprint: score.fingerprint,
        config: { partId: score.parts[0].id, range, repeatSelection: { kind: 'none' }, hand: config.hand, handMapping: hands,
          bpm: { numerator: config.tempo, denominator: 1 }, ticksPerQuarter: 960, countInUs: 0, unsupportedNotationPolicy: 'reject-strict' },
        ...(notes ? { noteRange: { startEventId: notes.start.eventId, endEventId: notes.end.eventId } } : {}) });
      if (version !== generation.current || !player.current) return;
      if (response.scoreFingerprint !== score.fingerprint) throw new Error('试听计划与当前曲谱不一致，请重试。');
      assertTimelineResponseUsable(response);
      const parsed = toPlaybackPlan(response, { range, repeatSelection: { kind: 'none' }, ...rangeSpanFromDocument(score.parts[0].measures, range) });
      const reference = buildReferencePlaybackPlan(parsed.plan, { bpm: config.tempo, countInBeats: 0, hand: 'both' });
      if (!reference.plan || !reference.strictAllowed) throw new Error('试听计划不可用。');
      // Keep rests/spacing in the Rust plan but seek directly to its first note.
      await player.current.start(reference.plan, { startAtMs: reference.plan.notes[0]?.atMs ?? 0 });
      if (version !== generation.current) player.current?.stop('cancelled');
    } catch (reason) {
      if (version !== generation.current) return;
      setActive(false); setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return { active, error, activeNoteIds, play, stop };
}
