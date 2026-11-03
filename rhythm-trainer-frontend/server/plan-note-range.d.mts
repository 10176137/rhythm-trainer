import type { ScoreDocumentV1 } from '../src/score-engine/contract-v1/plan-fingerprint';
export function applyPlanNoteRange(document: ScoreDocumentV1, selection: { startEventId: string; endEventId: string } | null | undefined,
  config: { partId: string; range: { startMeasureOrdinal: number; endMeasureOrdinal: number } }): ScoreDocumentV1;
