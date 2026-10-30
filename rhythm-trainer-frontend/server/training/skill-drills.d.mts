import type { DrillId, DrillLevel, DrillOptions, SkillDrillMaterial } from '../../shared/training-contract';
export * from './skill-drill-catalog.mjs';
export function createSkillDrill(id: DrillId, level: DrillLevel, bpm: number, options?: DrillOptions, variation?: { seed: number; variant?: number }): SkillDrillMaterial;
