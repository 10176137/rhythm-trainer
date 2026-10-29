// Display-only notation for server-generated questions; it does not choose targets.
import { keyFifths, spellMidi, type KeySelection } from './readingKeys';
import type { ReadingStaffPreference } from '../../../shared/reading-contract';
export type { ReadingStaffPreference } from '../../../shared/reading-contract';
/** Free-reading question rendering: ONE measure, whole-note chord, real notation. */
export function questionXml(midiNotes: readonly number[], staff: 1 | 2, key: KeySelection | null = null): string {
  if (!midiNotes.length) throw new Error('题目没有目标音');
  const fifths = key ? keyFifths(key) : 0;
  const sorted = [...midiNotes].sort((a, b) => a - b);
  const notes = sorted.map((midi, index) => {
    const { step, alter, octave } = spellMidi(midi, fifths);
    const chord = index > 0 ? '<chord/>' : '';
    return `<note>${chord}<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>1920</duration><voice>1</voice><type>whole</type><staff>${staff}</staff></note>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<score-partwise version="4.0">
  <work><work-title>自由识谱</work-title></work>
  <identification><creator type="composer">Rhythm Trainer 识谱训练</creator></identification>
  <part-list><score-part id="P1"><part-name>识谱训练</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>480</divisions><key><fifths>${fifths}</fifths><mode>${key ? key.mode : 'major'}</mode></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
      ${notes}
    </measure>
  </part>
</score-partwise>`;
}

export function questionStaff(midiNotes: readonly number[], preference: ReadingStaffPreference = 'auto'): 1 | 2 {
  if (preference === 'treble') return 1;
  if (preference === 'bass') return 2;
  const sorted = [...midiNotes].sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  return median >= 60 ? 1 : 2;
}
