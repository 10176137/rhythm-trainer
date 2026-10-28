// 81-key note-reading training: deterministic target generation.
//
// Two modes share one config shape:
//  - free:   N questions, each = notesPerEvent distinct pitches from the pool;
//            untimed, any-order matching happens in freeReadingSession.ts.
//  - rhythm: a legal multi-measure score (MusicXML) whose onset events each
//            carry notesPerEvent distinct pitches; feeds the EXISTING planner
//            → PracticePlanBundle → Rust timeline scoring. No second target
//            array is invented: the score IS the target data.
//
// Same config + seed + GENERATOR_VERSION => byte-identical output.

import {
  keyFifths,
  midiLabel,
  poolFromRanges,
  readingPool,
  spellMidi,
  type KeySelection,
  type PitchRange,
} from './readingKeys';

export const READING_GENERATOR_VERSION = 'reading-generator-1.1.0';

export type ReadingComplexity = 'basic' | 'intermediate' | 'advanced';
/** Which staff (hand) the generated notes are written on. */
export type ReadingStaffPreference = 'auto' | 'treble' | 'bass';

export interface ReadingConfig {
  mode: 'free' | 'rhythm';
  ranges: PitchRange[];
  notesPerEvent: 1 | 2 | 3 | 4;
  seed: number;
  /** null/undefined = chromatic (不限调); otherwise pool = key's diatonic scale. */
  key?: KeySelection | null;
  /** Staff/hand placement: auto by pitch, or fixed treble (right) / bass (left). */
  staffPreference?: ReadingStaffPreference;
  /** free only */
  questionCount?: 10 | 20 | 40;
  /** rhythm only */
  timeSignature?: [2 | 3 | 4, 4];
  bpm?: number;
  complexity?: ReadingComplexity;
  measures?: 2 | 4 | 8;
  countInMeasures?: 1 | 2;
}

export interface GeneratedReadingQuestion {
  midiNotes: number[];
}

export interface GeneratedRhythmScore {
  xml: string;
  contentFingerprint: string;
  summary: {
    measureCount: number;
    eventCount: number;
    noteCount: number;
    restCount: number;
    beatsPerBar: number;
  };
}

export class ReadingGeneratorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ReadingGeneratorError';
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function validate(config: ReadingConfig): number[] {
  const pool = readingPool(config.ranges, config.key ?? null);
  if (pool.length < config.notesPerEvent) {
    const keyNote = config.key ? '（已按调性筛选）' : '';
    throw new ReadingGeneratorError(
      'POOL_TOO_SMALL',
      `所选音域${keyNote}只有 ${pool.length} 个音，不足每事件 ${config.notesPerEvent} 个目标音；请扩大音域或减少同时音符数。`,
    );
  }
  if (!Number.isInteger(config.seed)) throw new ReadingGeneratorError('INVALID_SEED', 'seed 必须是整数');
  if (config.mode === 'free') {
    if (![10, 20, 40].includes(config.questionCount ?? 20)) {
      throw new ReadingGeneratorError('INVALID_QUESTION_COUNT', '题目数量必须是 10、20 或 40');
    }
  } else {
    const [beats] = config.timeSignature ?? [4, 4];
    if (![2, 3, 4].includes(beats)) throw new ReadingGeneratorError('INVALID_TIME_SIGNATURE', '拍号只支持 2/4、3/4、4/4');
    const bpm = config.bpm ?? 60;
    if (!Number.isFinite(bpm) || bpm < 40 || bpm > 180) {
      throw new ReadingGeneratorError('INVALID_BPM', '节奏识谱速度范围为 40–180 BPM');
    }
    if (![2, 4, 8].includes(config.measures ?? 4)) {
      throw new ReadingGeneratorError('INVALID_MEASURES', '小节数必须是 2、4 或 8');
    }
    if (![1, 2].includes(config.countInMeasures ?? 1)) {
      throw new ReadingGeneratorError('INVALID_COUNT_IN', '预备拍只能是 1 或 2 小节');
    }
  }
  return pool;
}

/** Picks `count` distinct pitches from `candidates` using the seeded RNG. */
function sampleDistinct(candidates: number[], count: number, rand: () => number): number[] {
  const copy = [...candidates];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count).sort((a, b) => a - b);
}

export function generateFreeQuestions(config: ReadingConfig): GeneratedReadingQuestion[] {
  if (config.mode !== 'free') throw new ReadingGeneratorError('WRONG_MODE', 'generateFreeQuestions 只接受 free 模式');
  const pool = validate(config);
  const rand = mulberry32(config.seed);
  const questions: GeneratedReadingQuestion[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < (config.questionCount ?? 20); index += 1) {
    // One staff side per question keeps the rendered chord on a single staff.
    const midiNotes = eventPitches(pool, config.notesPerEvent, config.staffPreference ?? 'auto', rand);
    seen.add(midiNotes.join(','));
    questions.push({ midiNotes });
  }
  return questions;
}

/** Free-reading question rendering: ONE measure, whole-note chord, real notation. */
export function questionXml(midiNotes: number[], staff: 1 | 2, key: KeySelection | null = null): string {
  if (!midiNotes.length) throw new ReadingGeneratorError('EMPTY_QUESTION', '题目没有目标音');
  const fifths = key ? keyFifths(key) : 0;
  const mode = key ? key.mode : 'major';
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
      <attributes><divisions>480</divisions><key><fifths>${fifths}</fifths><mode>${mode}</mode></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
      ${notes}
    </measure>
  </part>
</score-partwise>`;
}

export function questionStaff(midiNotes: number[], preference: ReadingStaffPreference = 'auto'): 1 | 2 {
  if (preference === 'treble') return 1;
  if (preference === 'bass') return 2;
  const sorted = [...midiNotes].sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  return median >= 60 ? 1 : 2;
}

interface RhythmSlot {
  beats: number;
  rest: boolean;
}

interface RhythmCell {
  beats: number;
  weight: number;
  slots: RhythmSlot[];
}

const CELLS: Record<ReadingComplexity, RhythmCell[]> = {
  basic: [
    { beats: 1, weight: 3, slots: [{ beats: 1, rest: false }] },
    { beats: 1, weight: 1, slots: [{ beats: 1, rest: true }] },
    { beats: 2, weight: 2, slots: [{ beats: 2, rest: false }] },
    { beats: 2, weight: 0.5, slots: [{ beats: 2, rest: true }] },
  ],
  intermediate: [
    { beats: 1, weight: 2, slots: [{ beats: 0.5, rest: false }, { beats: 0.5, rest: false }] },
    { beats: 1, weight: 1, slots: [{ beats: 0.5, rest: false }, { beats: 0.5, rest: true }] },
    { beats: 1, weight: 1, slots: [{ beats: 0.5, rest: true }, { beats: 0.5, rest: false }] },
    { beats: 2, weight: 1, slots: [{ beats: 1.5, rest: false }, { beats: 0.5, rest: false }] },
    { beats: 2, weight: 0.5, slots: [{ beats: 0.5, rest: false }, { beats: 1.5, rest: false }] },
  ],
  advanced: [
    { beats: 1, weight: 1, slots: [{ beats: 0.25, rest: false }, { beats: 0.25, rest: false }, { beats: 0.25, rest: false }, { beats: 0.25, rest: false }] },
    { beats: 1, weight: 1, slots: [{ beats: 0.5, rest: false }, { beats: 0.25, rest: false }, { beats: 0.25, rest: false }] },
    { beats: 1, weight: 1, slots: [{ beats: 0.25, rest: false }, { beats: 0.25, rest: false }, { beats: 0.5, rest: false }] },
    { beats: 1, weight: 0.5, slots: [{ beats: 0.25, rest: false }, { beats: 0.5, rest: false }, { beats: 0.25, rest: false }] },
    { beats: 2, weight: 1, slots: [{ beats: 0.5, rest: false }, { beats: 0.5, rest: false }, { beats: 1, rest: false }] },
  ],
};

function noteType(beats: number): { type: string; dots: number } {
  if (beats === 4) return { type: 'whole', dots: 0 };
  if (beats === 2) return { type: 'half', dots: 0 };
  if (beats === 1.5) return { type: 'quarter', dots: 1 };
  if (beats === 1) return { type: 'quarter', dots: 0 };
  if (beats === 0.5) return { type: 'eighth', dots: 0 };
  if (beats === 0.25) return { type: '16th', dots: 0 };
  throw new ReadingGeneratorError('INVALID_DURATION', `不支持的时值 ${beats} 拍`);
}

function pickCell(cells: RhythmCell[], remaining: number, rand: () => number): RhythmCell {
  const options = cells.filter((cell) => cell.beats <= remaining);
  const total = options.reduce((sum, cell) => sum + cell.weight, 0);
  let roll = rand() * total;
  for (const cell of options) {
    roll -= cell.weight;
    if (roll <= 0) return cell;
  }
  return options[options.length - 1];
}

/**
 * Event chord: all pitches come from ONE staff side so a multi-note event
 * never spans staves. With a fixed staffPreference the "side" IS that staff;
 * with auto it splits at C4. Falls back to the whole pool when one side
 * cannot satisfy notesPerEvent.
 */
function eventPitches(pool: number[], notesPerEvent: number, preference: ReadingStaffPreference, rand: () => number): number[] {
  const inStaff = (midi: number) => staffFor(midi, preference) === 1;
  const preferTreble = preference === 'auto' ? rand() < 0.5 : preference === 'treble';
  const sides = preferTreble
    ? [pool.filter(inStaff), pool.filter((midi) => !inStaff(midi))]
    : [pool.filter((midi) => !inStaff(midi)), pool.filter(inStaff)];
  for (const side of sides) {
    if (side.length >= notesPerEvent) return sampleDistinct(side, notesPerEvent, rand);
  }
  return sampleDistinct(pool, notesPerEvent, rand);
}

function staffFor(midi: number, preference: ReadingStaffPreference): 1 | 2 {
  if (preference === 'treble') return 1;
  if (preference === 'bass') return 2;
  return midi >= 60 ? 1 : 2;
}

export function generateRhythmScore(config: ReadingConfig): GeneratedRhythmScore {
  if (config.mode !== 'rhythm') throw new ReadingGeneratorError('WRONG_MODE', 'generateRhythmScore 只接受 rhythm 模式');
  const pool = validate(config);
  const fifths = config.key ? keyFifths(config.key) : 0;
  const keyMode = config.key ? config.key.mode : 'major';
  const preference = config.staffPreference ?? 'auto';
  const [beats] = config.timeSignature ?? [4, 4];
  const measures = config.measures ?? 4;
  const cells = [
    ...CELLS.basic,
    ...(config.complexity === 'basic' ? [] : CELLS.intermediate),
    ...(config.complexity === 'advanced' ? CELLS.advanced : []),
  ];
  const rand = mulberry32(config.seed);
  const beatsPerBar = beats;
  let eventCount = 0;
  let noteCount = 0;
  let restCount = 0;
  const measuresXml: string[] = [];
  for (let bar = 1; bar <= measures; bar += 1) {
    let remaining = beatsPerBar;
    const notesXml: string[] = [];
    while (remaining > 0) {
      const cell = pickCell(cells, remaining, rand);
      remaining -= cell.beats;
      for (const slot of cell.slots) {
        const duration = Math.round(slot.beats * 480);
        const { type, dots } = noteType(slot.beats);
        if (slot.rest) {
          restCount += 1;
          // Rests follow the staff preference too: a left-hand drill must not
          // scatter rests onto the treble staff.
          const restStaff = staffFor(preference === 'auto' ? 60 : 48, preference);
          notesXml.push(`<note><rest/><duration>${duration}</duration><voice>1</voice><type>${type}</type>${dots ? '<dot/>' : ''}<staff>${restStaff}</staff></note>`);
          continue;
        }
        eventCount += 1;
        const pitches = eventPitches(pool, config.notesPerEvent, preference, rand);
        noteCount += pitches.length;
        pitches.forEach((midi, index) => {
          const { step, alter, octave } = spellMidi(midi, fifths);
          const staff = staffFor(midi, preference);
          notesXml.push(
            `<note>${index > 0 ? '<chord/>' : ''}<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>${duration}</duration><voice>1</voice><type>${type}</type>${dots ? '<dot/>' : ''}<staff>${staff}</staff></note>`,
          );
        });
      }
    }
    const attributes = bar === 1
      ? `<attributes><divisions>480</divisions><key><fifths>${fifths}</fifths><mode>${keyMode}</mode></key><time><beats>${beats}</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`
      : '';
    measuresXml.push(`<measure number="${bar}">${attributes}${notesXml.join('')}</measure>`);
  }
  const keyLabel = config.key ? ` · ${config.key.root}${keyMode === 'major' ? '大调' : '小调'}` : '';
  const staffLabel = preference === 'treble' ? ' · 右手' : preference === 'bass' ? ' · 左手' : '';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<score-partwise version="4.0">
  <work><work-title>节奏识谱 · ${beats}/4 · ${measures} 小节 · ${config.complexity === 'basic' ? '基础' : config.complexity === 'intermediate' ? '进阶' : '高级'}${keyLabel}${staffLabel}</work-title></work>
  <identification><creator type="composer">Rhythm Trainer 识谱训练</creator><encoding><software>${READING_GENERATOR_VERSION}</software></encoding></identification>
  <part-list><score-part id="P1"><part-name>节奏识谱练习</part-name></score-part></part-list>
  <part id="P1">
    ${measuresXml.join('\n    ')}
  </part>
</score-partwise>`;
  return {
    xml,
    contentFingerprint: `reading-v1:${fnv1a(xml)}`,
    summary: { measureCount: measures, eventCount, noteCount, restCount, beatsPerBar },
  };
}

export function readingPoolLabel(ranges: readonly PitchRange[]): string {
  const pool = poolFromRanges(ranges);
  if (!pool.length) return '未选音域';
  return `${midiLabel(pool[0])}–${midiLabel(pool[pool.length - 1])} · ${pool.length} 音`;
}
