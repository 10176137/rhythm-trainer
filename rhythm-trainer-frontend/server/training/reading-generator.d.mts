import type { ReadingConfig, GeneratedReadingQuestion, GeneratedRhythmScore } from '../../shared/reading-contract';
export type { ReadingConfig, GeneratedReadingQuestion, GeneratedRhythmScore } from '../../shared/reading-contract';
export const READING_GENERATOR_VERSION: string;
export class ReadingGeneratorError extends Error { readonly code: string; constructor(code: string, message: string) }
export function generateFreeQuestions(config: ReadingConfig): GeneratedReadingQuestion[];
export function generateReviewQuestions(config: ReadingConfig, failedGroups: readonly (readonly number[])[]): GeneratedReadingQuestion[];
export function generateRhythmScore(config: ReadingConfig): GeneratedRhythmScore;
