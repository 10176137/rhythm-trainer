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
  program?: TrainingProgram;
  schemaVersion: 1;
  generatorVersion: string;
  id: DrillId;
  level: DrillLevel;
  bpm: number;
  key: DrillKey;
  startPitchLabels: Partial<Record<'left' | 'right', string>>;
  countInMs: number;
  lesson: { label: string; pattern: string; instructions: string[]; review: string; selfCheck: string };
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

export interface TrainingProgramConfig {
  mode: 'timed' | 'continuous' | 'assessment'; minutes: 2 | 5 | 10;
  variation: 'repeat' | 'shuffle'; ids: DrillId[]; keys: DrillKey[];
  hand: DrillHand; level: DrillLevel; bpm: number; seed?: number;
}
export interface ProgramSection { id: DrillId; title: string; startBar: number; endBar: number; key: DrillKey; hand: DrillHand }
export interface TrainingProgram { id: string; rootId: string; config: TrainingProgramConfig; sections: ProgramSection[]; seconds: number; remainingSeconds: number | null; benchmarkVersion: string | null }
export interface TrainingProgramReview {
  finishedAtIso?: string;
  unlocatedExtras?: number;
  comparison?: { previousTakeId: string; before: number; now: number; changePoints: number };
  schemaVersion: 1; programId: string; takeId: string; assessable: boolean; label: string; advice: string; criteria: string;
  sections: Array<ProgramSection & { targets: number; correct: number; wrong: number; missing: number; extra: number; accuracy: number | null; meanAbsoluteMs: number | null; status: string }>;
}
