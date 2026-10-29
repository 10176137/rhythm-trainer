import { SKILL_DRILLS } from './skill-drill-catalog.mjs';
import { createFundamentalDrill } from './fundamental-drills.mjs';
export * from './skill-drill-catalog.mjs';

// Every token carries its duration in quarter-note units; every voice fills 4/4.
// Rhythm drills deliberately keep pitch fixed to isolate timing from finding keys.
function rhythmVoice(id, level, bar, left = false) {
    const tokens = (durations, rests = []) => durations.map((beats, i) => ({ beats, rest: rests.includes(i) }));
    if (id === 'coordination') {
        if (level === 1) return tokens([1, 1, 1, 1]);
        if (level === 2) return tokens(left ? [2, 2] : Array(8).fill(.5));
        // Alternate quarters, with shared attacks at the beginning/end of each phrase.
        return tokens([1, 1, 1, 1], bar % 2 === 0 ? (left ? [1, 3] : [2]) : (left ? [1] : [0, 2]));
    }
    if (id === 'pulse') return tokens([1, 1, 1, 1], level === 3 && bar % 2 === 1 ? [3] : []);
    if (id === 'subdivision') {
        if (level === 1) return tokens(bar % 2 ? Array(8).fill(.5) : [1, 1, 1, 1]);
        if (level === 2) return tokens(Array(8).fill(.5));
        return tokens(bar % 2 ? [1, .5, .5, 1, .5, .5] : [.5, .5, 1, .5, .5, 1]);
    }
    if (level === 1) return tokens([.5, .5, 1, 1, 1], [0]);
    if (level === 2) return tokens([.5, 1, .5, .5, 1, .5], [0]);
    return tokens([.5, 1.5, .5, 1.5], [0, 2]);
}

export function createSkillDrill(id, level, bpm, options) {
    const drill = SKILL_DRILLS.find((entry) => entry.id === id);
    if (!drill || ![1, 2, 3].includes(level) || !Number.isInteger(bpm) || bpm < 40 || bpm > 140)
        throw new Error('专项训练参数无效');
    if (drill.category === 'fundamentals') return createFundamentalDrill(id, level, bpm, options ?? { key: 'C', hand: 'right' });
    const bars = level === 1 ? 4 : 8;
    const both = id === 'coordination';
    function note({ beats, rest }, staff) {
        const type = beats === .5 ? 'eighth' : beats === 2 ? 'half' : 'quarter';
        return `<note>${rest ? '<rest/>' : `<pitch><step>C</step><octave>${staff === 2 ? 3 : 4}</octave></pitch>`}<duration>${beats * 480}</duration><voice>${staff}</voice><type>${type}</type>${beats === 1.5 ? '<dot/>' : ''}<staff>${staff}</staff></note>`;
    }
    const title = `${drill.title} · 第 ${level} 级`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${Array.from({ length: bars }, (_, bar) => {
        const attrs = bar === 0 ? `<attributes><divisions>480</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>${both ? 2 : 1}</staves><clef number="1"><sign>G</sign><line>2</line></clef>${both ? '<clef number="2"><sign>F</sign><line>4</line></clef>' : ''}</attributes><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>` : '';
        const right = rhythmVoice(id, level, bar).map((token) => note(token, 1)).join('');
        const left = both ? '<backup><duration>1920</duration></backup>' + rhythmVoice(id, level, bar, true).map((token) => note(token, 2)).join('') : '';
        return `<measure number="${bar + 1}">${attrs}${right}${left}</measure>`;
    }).join('')}</part></score-partwise>`;
    const hand = both ? 'both' : 'right';
    const staffHands = both ? [{ staffNumber: 1, hand: 'right' }, { staffNumber: 2, hand: 'left' }] : [{ staffNumber: 1, hand: 'right' }];
    return { xml, title, bars, staffHands, startPitches: { right: 60, ...(both ? { left: 48 } : {}) }, keyLabel: 'C 大调', hand };
}
