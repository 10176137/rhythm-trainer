import { spellMidi } from '../../shared/reading-keys.mjs';
import { supportsStaffPitch } from '../../shared/staff-range.mjs';
import { DRILL_KEYS, FUNDAMENTAL_DRILLS } from './skill-drill-catalog.mjs';
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export function degreeMidi(degree, root) {
    return root + Math.floor(degree / 7) * 12 + MAJOR[degree % 7];
}
/** Reference fingerings for the explicitly authored five-finger and scale patterns.
 * They are notation only; no MIDI observation can identify the performed finger. */
function fingerFor(id, degree, hand, key, level) {
    if (id === 'five-finger')
        return hand === 'right' ? degree + 1 : 5 - degree;
    if (id !== 'scales')
        return null;
    const right = key === 'F'
        ? (level === 3 ? [1, 2, 3, 4, 1, 2, 3, 1, 2, 3, 4, 1, 2, 3, 4] : [1, 2, 3, 4, 1, 2, 3, 4])
        : (level === 3 ? [1, 2, 3, 1, 2, 3, 4, 1, 2, 3, 1, 2, 3, 4, 5] : [1, 2, 3, 1, 2, 3, 4, 5]);
    const left = level === 3 ? [5, 4, 3, 2, 1, 3, 2, 1, 4, 3, 2, 1, 3, 2, 1] : [5, 4, 3, 2, 1, 3, 2, 1];
    return (hand === 'right' ? right : left)[degree] ?? null;
}
function tokenAt(id, level, index) {
    if (id === 'five-finger') {
        const sequence = level === 1 ? [0, 1, 2, 3, 4, 3, 2, 1] : level === 2 ? [0, 2, 1, 3, 2, 4, 3, 1] : [0, 1, 2, 3, 4, 3, 2, 1, 0, 2, 4, 1, 3, 4, 2, 0];
        return [sequence[index % sequence.length]];
    }
    if (id === 'scales') {
        const top = level === 3 ? 14 : 7;
        const sequence = [...Array.from({ length: top + 1 }, (_, i) => i), ...Array.from({ length: top }, (_, i) => top - 1 - i)];
        while (sequence.length % 8)
            sequence.push(null);
        const degree = sequence[index % sequence.length];
        return degree === null ? null : [degree];
    }
    if (id === 'arpeggios') {
        const sequence = level === 3 ? [0, 2, 4, 7, 9, 11, 14, 11, 9, 7, 4, 2, 0, null, null, null] : [0, 2, 4, 7, 4, 2, 0, null];
        const degree = sequence[index % sequence.length];
        return degree === null ? null : [degree];
    }
    if (id === 'triads') {
        if (level === 1)
            return [0, 2, 4];
        if (level === 2)
            return [[0, 2, 4], [2, 4, 7], [4, 7, 9], [2, 4, 7]][index % 4];
        const root = [0, 3, 4, 0][index % 4];
        return [root, root + 2, root + 4];
    }
    if (id === 'broken-chords') {
        if (level === 1)
            return [[0, 2, 4, 2][index % 4]];
        if (level === 2) {
            const inversion = [[0, 2, 4], [2, 4, 7], [4, 7, 9]][Math.floor(index / 8) % 3];
            return [inversion[[0, 1, 2, 1][index % 4]]];
        }
        const root = [0, 3, 4, 0][Math.floor(index / 8) % 4];
        return [root + [0, 4, 2, 4][index % 4]];
    }
    return [(level === 1 ? [0, 4] : level === 2 ? [0, 7] : [0, 7, 2, 9, 4, 11, 2, 7])[index % (level === 3 ? 8 : 2)]];
}
export function createFundamentalDrill(id, level, bpm, options) {
    const definition = FUNDAMENTAL_DRILLS.find((entry) => entry.id === id);
    if (!definition || ![1, 2, 3].includes(level) || !Number.isInteger(bpm) || bpm < 40 || bpm > 140
        || !Object.hasOwn(DRILL_KEYS, options.key) || !['right', 'left', 'both'].includes(options.hand))
        throw new Error('基本功训练参数无效');
    const key = DRILL_KEYS[options.key];
    const bars = level === 1 ? 4 : 8;
    const beats = id === 'triads' ? 2 : level === 1 ? 1 : .5;
    const perBar = 4 / beats;
    const hands = options.hand === 'both' ? ['right', 'left'] : [options.hand];
    const staffHands = hands.map((hand, i) => ({ staffNumber: i + 1, hand }));
    const tokens = Array.from({ length: bars * perBar }, (_, index) => {
        if (index === bars * perBar - 1 && ['five-finger', 'broken-chords', 'leaps'].includes(id))
            return [0];
        if (index === bars * perBar - 1 && id === 'triads')
            return [0, 2, 4];
        return tokenAt(id, level, index);
    });
    const startPitches = {};
    for (const hand of hands) {
        const base = key.root - (hand === 'left' ? 12 : 0);
        // Keep every authored note inside the same staff range accepted at launch.
        // Move the whole pattern an octave, preserving intervals and fingerings.
        const root = [base, base - 12].find((candidate) => tokens.every((token) => !token || token.every((degree) => {
            const pitch = spellMidi(degreeMidi(degree, candidate), key.fifths);
            return supportsStaffPitch(hand === 'left' ? 'bass' : 'treble', pitch.step, pitch.alter, pitch.octave);
        })));
        if (root === undefined)
            throw new Error('当前音型超出练习谱表范围');
        startPitches[hand] = root;
    }
    const title = `${definition.title} · ${key.label} · ${options.hand === 'both' ? '双手' : options.hand === 'left' ? '左手' : '右手'} · 第 ${level} 级`;
    const renderNote = (degree, staff, hand, chord) => {
        const pitch = degree === null ? null : spellMidi(degreeMidi(degree, startPitches[hand]), key.fifths);
        const finger = degree === null ? null : fingerFor(id, degree, hand, options.key, level);
        return `<note>${chord ? '<chord/>' : ''}${pitch ? `<pitch><step>${pitch.step}</step>${pitch.alter ? `<alter>${pitch.alter}</alter>` : ''}<octave>${pitch.octave}</octave></pitch>` : '<rest/>'}<duration>${beats * 480}</duration><voice>${staff}</voice><type>${beats === 2 ? 'half' : beats === 1 ? 'quarter' : 'eighth'}</type><staff>${staff}</staff>${finger ? `<notations><technical><fingering placement="above">${finger}</fingering></technical></notations>` : ''}</note>`;
    };
    const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${Array.from({ length: bars }, (_, bar) => {
        const attributes = bar === 0 ? `<attributes><divisions>480</divisions><key><fifths>${key.fifths}</fifths><mode>major</mode></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>${hands.length}</staves>${staffHands.map(({ staffNumber, hand }) => `<clef number="${staffNumber}"><sign>${hand === 'left' ? 'F' : 'G'}</sign><line>${hand === 'left' ? 4 : 2}</line></clef>`).join('')}</attributes><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>` : '';
        const voices = staffHands.map(({ staffNumber, hand }, handIndex) => `${handIndex ? '<backup><duration>1920</duration></backup>' : ''}${Array.from({ length: perBar }, (_, slot) => {
            const index = bar * perBar + slot;
            const token = tokens[index];
            return token === null ? renderNote(null, staffNumber, hand, false) : token.map((degree, i) => renderNote(degree, staffNumber, hand, i > 0)).join('');
        }).join('')}`).join('');
        return `<measure number="${bar + 1}">${attributes}${voices}</measure>`;
    }).join('')}</part></score-partwise>`;
    return { xml, title, bars, staffHands, startPitches, keyLabel: key.label, hand: options.hand };
}
