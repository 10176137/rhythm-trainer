export const MAX_LEDGER_LINES: 3;
export const STAFF_BOTTOM_INDEX: { readonly treble: 30; readonly bass: 18 };
export function supportsStaffPitch(staff: 'treble' | 'bass', step: string, alter: number, octave: number): boolean;
