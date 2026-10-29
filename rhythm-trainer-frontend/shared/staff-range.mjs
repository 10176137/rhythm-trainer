/** Music-domain bounds, shared by server register selection and client drawing. */
export const MAX_LEDGER_LINES = 3;
export const STAFF_BOTTOM_INDEX = { treble: 30, bass: 18 }; // E4 / G2
export function supportsStaffPitch(staff, step, alter, octave) {
  const index = ['C', 'D', 'E', 'F', 'G', 'A', 'B'].indexOf(step);
  if (index < 0 || !Object.hasOwn(STAFF_BOTTOM_INDEX, staff) || Math.abs(alter) > 2) return false;
  const offset = octave * 7 + index - STAFF_BOTTOM_INDEX[staff];
  return offset >= -MAX_LEDGER_LINES * 2 && offset <= 8 + MAX_LEDGER_LINES * 2;
}
