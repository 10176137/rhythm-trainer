import { SKILL_DRILLS, type DrillId, type DrillLevel, type DrillOptions } from './skillDrillCatalog';
import { createFundamentalDrill } from './fundamentalDrills';
export * from './skillDrillCatalog';

export function createSkillDrill(id: DrillId, level: DrillLevel, bpm: number, options?: DrillOptions) {
  const drill = SKILL_DRILLS.find((entry) => entry.id === id);
  if (!drill || ![1, 2, 3].includes(level) || !Number.isInteger(bpm) || bpm < 40 || bpm > 140) throw new Error('专项训练参数无效');
  if (drill.category === 'fundamentals') return createFundamentalDrill(id as import('./skillDrillCatalog').FundamentalDrillId, level, bpm, options ?? { key: 'C', hand: 'right' });
  const bars = level === 1 ? 4 : 8;
  // Quarter-note units: one pattern is exactly one 4/4 measure.
  const pattern = id === 'subdivision' ? (level === 1 ? [1, 1, .5, .5, 1] : level === 2 ? Array(8).fill(.5) as number[] : [.5, .5, .5, .5, 1, .5, .5])
    : id === 'syncopation' ? (level === 1 ? [.5, .5, 1, 1, 1] : level === 2 ? [.5, 1, .5, .5, 1, .5] : [.5, 1, .5, 1, .5, .5])
    : id === 'coordination' && level > 1 ? Array(8).fill(.5) as number[] : [1, 1, 1, 1];
  const pitches = ['C', 'D', 'E', 'F', 'G'];
  function note(step: string, octave: number, beats: number, staff: number, rest = false) {
    return `<note>${rest ? '<rest/>' : `<pitch><step>${step}</step><octave>${octave}</octave></pitch>`}<duration>${beats * 480}</duration><voice>${staff}</voice><type>${beats === .5 ? 'eighth' : beats === 2 ? 'half' : 'quarter'}</type><staff>${staff}</staff></note>`;
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${drill.title} · 第 ${level} 级</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${Array.from({ length: bars }, (_, bar) => {
    const attrs = bar === 0 ? `<attributes><divisions>480</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>${id === 'coordination' ? 2 : 1}</staves><clef number="1"><sign>G</sign><line>2</line></clef>${id === 'coordination' ? '<clef number="2"><sign>F</sign><line>4</line></clef>' : ''}</attributes><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>` : '';
    const right = pattern.map((duration, index) => note(pitches[level === 1 ? 0 : (bar + index * (level === 3 ? 2 : 1)) % 5], 4, duration, 1, id === 'syncopation' && index === 0 || id === 'coordination' && level === 3 && index % 4 === 0)).join('');
    const left = id === 'coordination' ? '<backup><duration>1920</duration></backup>' + (level === 1 ? [1, 1, 1, 1] : [2, 2]).map((duration, index) => note(bar % 2 ? 'G' : 'C', 3, duration, 2, level === 3 && index === 1)).join('') : '';
    return `<measure number="${bar + 1}">${attrs}${right}${left}</measure>`;
  }).join('')}</part></score-partwise>`;
  const hand = id === 'coordination' ? 'both' as const : 'right' as const;
  const staffHands: Array<{ staffNumber: number; hand: 'right' | 'left' }> = id === 'coordination' ? [{ staffNumber: 1, hand: 'right' }, { staffNumber: 2, hand: 'left' }] : [{ staffNumber: 1, hand: 'right' }];
  const startPitches: Partial<Record<'right' | 'left', number>> = { right: 60, ...(hand === 'both' ? { left: 48 } : {}) };
  return { xml, title: `${drill.title} · 第 ${level} 级`, bars, staffHands, startPitches, keyLabel: 'C 大调', hand };
}
