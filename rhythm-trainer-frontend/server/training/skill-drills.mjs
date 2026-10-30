import { SKILL_DRILLS } from './skill-drill-catalog.mjs';
import { createFundamentalDrill } from './fundamental-drills.mjs';
import { phraseMetadata } from './phrase-strategy.mjs';
export * from './skill-drill-catalog.mjs';

// Every token carries its duration in quarter-note units; every voice fills 4/4.
// Rhythm drills deliberately keep pitch fixed to isolate timing from finding keys.
function baseRhythmVoice(id, level, bar, left = false) {
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

function rhythmVoice(id, level, bar, left, variation) {
    if (!variation || id === 'pulse' || bar < 2) return baseRhythmVoice(id, level, bar, left);
    const tokens = (durations, rests = []) => durations.map((beats, i) => ({ beats, rest: rests.includes(i) }));
    const v = ((variation.seed >>> 0) + (variation.variant ?? 0)) % 3;
    if (bar === (level === 1 ? 3 : 7)) {
        if (id === 'syncopation') return tokens(level === 1 ? [.5, .5, 1, 2] : [.5, 1, .5, 2], [0]);
        return tokens(id === 'coordination' && level > 1 ? [2, 2] : level === 1 ? [1, 1, 2] : [.5, .5, 1, 2]);
    }
    if (id === 'subdivision') return tokens([[1, .5, .5, 1, .5, .5], [.5, .5, 1, .5, .5, 1], [1, 1, .5, .5, 1]][(bar + v) % 3]);
    if (id === 'syncopation') {
        if (level === 1) return v === 0 ? tokens([.5, .5, 1, 1, 1], [0]) : v === 1 ? tokens([1, .5, .5, 1, 1], [1]) : tokens([1, 1, .5, .5, 1], [2]);
        if (level === 2) return tokens([.5, 1, .5, .5, 1, .5], v === 0 ? [0] : v === 1 ? [3] : [0, 3]);
        return v === 0 ? tokens([.5, 1.5, .5, 1.5], [0, 2]) : v === 1 ? tokens([1.5, .5, 1.5, .5], [1, 3]) : tokens([.5, 1.5, 1, .5, .5], [0, 3]);
    }
    if (level === 1) return tokens([[1, 1, 2], [2, 1, 1], [1, 2, 1]][v], [1]);
    if (level === 2) return left ? tokens([2, 2]) : tokens([[1, .5, .5, 1, .5, .5], [.5, .5, 1, .5, .5, 1], [.5, .5, .5, .5, .5, .5, .5, .5]][(bar + v) % 3]);
    if (v === 2) return tokens([1, 1, 1, 1], bar % 2 === 0 ? (left ? [0, 2] : [1]) : (left ? [1] : [0, 2]));
    return baseRhythmVoice(id, level, bar + v, left);
}

export function createSkillDrill(id, level, bpm, options, variation) {
    const drill = SKILL_DRILLS.find((entry) => entry.id === id);
    if (!drill || ![1, 2, 3].includes(level) || !Number.isInteger(bpm) || bpm < 40 || bpm > 140)
        throw new Error('专项训练参数无效');
    if (drill.category === 'fundamentals') return createFundamentalDrill(id, level, bpm, options ?? { key: 'C', hand: 'right' }, variation);
    const bars = level === 1 ? 4 : 8;
    const both = id === 'coordination';
    function note({ beats, rest }, staff) {
        const type = beats === .5 ? 'eighth' : beats === 2 ? 'half' : 'quarter';
        return `<note>${rest ? '<rest/>' : `<pitch><step>C</step><octave>${staff === 2 ? 3 : 4}</octave></pitch>`}<duration>${beats * 480}</duration><voice>${staff}</voice><type>${type}</type>${beats === 1.5 ? '<dot/>' : ''}<staff>${staff}</staff></note>`;
    }
    const title = `${drill.title} · 第 ${level} 级`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${Array.from({ length: bars }, (_, bar) => {
        const attrs = bar === 0 ? `<attributes><divisions>480</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>${both ? 2 : 1}</staves><clef number="1"><sign>G</sign><line>2</line></clef>${both ? '<clef number="2"><sign>F</sign><line>4</line></clef>' : ''}</attributes><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>` : '';
        const right = rhythmVoice(id, level, bar, false, variation).map((token) => note(token, 1)).join('');
        const left = both ? '<backup><duration>1920</duration></backup>' + rhythmVoice(id, level, bar, true, variation).map((token) => note(token, 2)).join('') : '';
        return `<measure number="${bar + 1}">${attrs}${right}${left}${variation && bar === bars - 1 ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : ''}</measure>`;
    }).join('')}</part></score-partwise>`;
    const hand = both ? 'both' : 'right';
    const staffHands = both ? [{ staffNumber: 1, hand: 'right' }, { staffNumber: 2, hand: 'left' }] : [{ staffNumber: 1, hand: 'right' }];
    const patterns = { pulse: '右手固定 C4，连续四分音符练内心拍点；第三级在句尾加入休止，音高保持固定。',
      subdivision: '右手固定 C4；先练基础均分，中段切换四分与八分音符，最后用长音收束。',
      syncopation: '右手固定 C4；先练弱拍进入，中段改变休止位置与长音组合，末尾保持两拍收束。',
      coordination: `右手 C4、左手 C3；${level === 1 ? '先同奏，再练一起保持和休止' : level === 2 ? '左手保持二分音符，右手切换四分与八分音符' : '先练双手交替，中段变化单手与合手位置'}，最后合手收束。` };
    return { xml, title, bars, staffHands, startPitches: { right: 60, ...(both ? { left: 48 } : {}) }, keyLabel: 'C 大调', hand,
      ...(variation ? { phrase: phraseMetadata(id, level, variation.seed, id === 'pulse' ? 0 : ((variation.seed >>> 0) + (variation.variant ?? 0)) % 3, patterns[id]) } : {}) };
}
