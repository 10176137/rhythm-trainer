import type { PracticeModeId } from '../../types/practice';

/** Whether the backend should wait for a correct first key before its clock runs. */
export function waitsForFirstInput(modeId: PracticeModeId): boolean {
  return modeId === 'score';
}

/** Only reading performance prepares a Take automatically on entry. */
export function automaticallyStartsPerformance(modeId: PracticeModeId): boolean {
  return modeId === 'score';
}
