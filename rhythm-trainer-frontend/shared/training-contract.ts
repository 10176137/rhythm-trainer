export type RhythmDrillId = 'pulse' | 'subdivision' | 'syncopation' | 'coordination';
export type FundamentalDrillId = 'five-finger' | 'scales' | 'broken-chords' | 'triads' | 'arpeggios' | 'leaps';
export type DrillId = RhythmDrillId | FundamentalDrillId;
export type DrillLevel = 1 | 2 | 3;
export type DrillKey = 'C' | 'G' | 'F';
export type DrillHand = 'right' | 'left' | 'both';
export interface DrillOptions { key: DrillKey; hand: DrillHand }
export interface SkillDrillDefinition {
  id: DrillId;
  category: 'fundamentals' | 'rhythm';
  title: string;
  subtitle: string;
  goal: string;
  review: string;
  icon: string;
  levels: readonly [string, string, string];
  steps: readonly string[];
  selfCheck: string;
}

/** Wire contracts only. Exercise rules and catalog contents live on Node. */
export interface SkillDrillMaterial {
  xml: string;
  title: string;
  bars: number;
  staffHands: Array<{ staffNumber: number; hand: 'left' | 'right' }>;
  startPitches: Partial<Record<'left' | 'right', number>>;
  keyLabel: string;
  hand: DrillHand;
}
export interface GeneratedSkillDrill extends SkillDrillMaterial {
  schemaVersion: 1;
  generatorVersion: string;
  id: DrillId;
  level: DrillLevel;
  bpm: number;
  key: DrillKey;
  startPitchLabels: Partial<Record<'left' | 'right', string>>;
  countInMs: number;
}
export interface TrainingCatalog {
  schemaVersion: 1;
  generatorVersion: string;
  drills: Array<SkillDrillDefinition & { hasReferenceFingering: boolean }>;
  keys: Array<{ id: DrillKey; label: string }>;
  hands: Array<{ id: DrillHand; label: string }>;
  tempo: { min: number; max: number; step: number; default: number };
}
export interface SkillDrillRequest { id: DrillId; level: DrillLevel; bpm: number; options?: DrillOptions }
