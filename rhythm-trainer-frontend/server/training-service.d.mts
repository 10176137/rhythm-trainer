import type { TrainingCatalog, SkillDrillRequest, GeneratedSkillDrill } from '../shared/training-contract';
import type { ReadingConfig, GeneratedReadingExercise } from '../shared/reading-contract';
export const TRAINING_SCHEMA_VERSION: 1;
export class TrainingServiceError extends Error { code: string; status: number }
export function getTrainingCatalog(): TrainingCatalog;
export function generateSkillExercise(input: SkillDrillRequest): GeneratedSkillDrill;
export function generateReadingExercise(input: { config: ReadingConfig; reviewAttemptId?: string }, options?: { findReadingAttempt?: (id: string) => { summary: { reviewGroups: number[][] } } | null }): GeneratedReadingExercise;
