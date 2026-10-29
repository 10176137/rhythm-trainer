import type { SkillDrillDefinition } from '../../shared/training-contract';
export type { DrillId, DrillLevel, DrillOptions, DrillKey, DrillHand, FundamentalDrillId } from '../../shared/training-contract';
export const FUNDAMENTAL_DRILLS: readonly SkillDrillDefinition[];
export const RHYTHM_DRILLS: readonly SkillDrillDefinition[];
export const SKILL_DRILLS: readonly SkillDrillDefinition[];
export const DRILL_KEYS: { C: { label: string; fifths: number; root: number }; G: { label: string; fifths: number; root: number }; F: { label: string; fifths: number; root: number } };
