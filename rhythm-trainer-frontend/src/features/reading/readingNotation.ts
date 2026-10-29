// Display-only notation for server-generated questions; it does not choose targets.
import { keyFifths, spellMidi, type KeySelection } from './readingKeys';
import type { ReadingStaffPreference } from '../../../shared/reading-contract';
export type { ReadingStaffPreference } from '../../../shared/reading-contract';
/** Free-reading question rendering: ONE measure, whole-note chord, real notation. */
export function questionXml(midiNotes: readonly number[], staff: 1 | 2, key: KeySelection | null = null, colors?: ReadonlyMap<number, string>): string {
  if (!midiNotes.length) throw new Error('题目没有目标音');
  const fifths = key ? keyFifths(key) : 0;
  const sorted = [...midiNotes].sort((a, b) => a - b);
  const notes = sorted.map((midi, index) => {
    const { step, alter, octave } = spellMidi(midi, fifths);
    const chord = index > 0 ? '<chord/>' : '';
    const color = colors?.get(midi);
    return `<note${color ? ` color="${color}"` : ''}>${chord}<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>1920</duration><voice>1</voice><type>whole</type>${color ? `<notehead color="${color}">normal</notehead>` : ''}<staff>${staff}</staff></note>`;
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

/** Display only: held wrong notes never enter the exercise or saved questions. */
export function readingFeedbackXml(targets: readonly number[], hits: readonly number[], wrong: readonly number[], staff: 1 | 2, key: KeySelection | null): string {
  const colors = new Map<number, string>();
  for (const midi of hits) if (targets.includes(midi)) colors.set(midi, '#1D9B72');
  const errors = [...new Set(wrong.filter((midi) => !targets.includes(midi)))];
  const gap = `<backup><duration>1920</duration></backup><note print-object="no" print-spacing="yes"><rest/><duration>960</duration><voice>2</voice><type>half</type><staff>${staff}</staff></note>`;
  // A separate onset keeps a wrong accidental from changing the target chord.
  const ghosts = errors.length
    ? questionXml(errors, staff, key, new Map(errors.map((midi) => [midi, '#C34B58'])))
      .match(/<note(?:\s[^>]*)?>[\s\S]*?<\/note>/g)!.join('')
      .replaceAll('<duration>1920</duration>', '<duration>960</duration>')
      .replaceAll('<voice>1</voice>', '<voice>2</voice>')
      .replaceAll('<type>whole</type>', '<type>half</type><stem>none</stem>')
    : `<note print-object="no" print-spacing="yes"><rest/><duration>960</duration><voice>2</voice><type>half</type><staff>${staff}</staff></note>`;
  return questionXml(targets, staff, key, colors).replace('</measure>', `${gap}${ghosts}</measure>`);
}

export function questionStaff(midiNotes: readonly number[], preference: ReadingStaffPreference = 'auto'): 1 | 2 {
  if (preference === 'treble') return 1;
  if (preference === 'bass') return 2;
  const sorted = [...midiNotes].sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  return median >= 60 ? 1 : 2;
}
