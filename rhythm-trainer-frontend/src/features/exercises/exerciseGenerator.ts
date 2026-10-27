// Deterministic exercise generator for the rhythm-pattern / arpeggio mode.
//
// It emits a normal MusicXML part which the existing importer turns into the
// canonical ScoreDocument. The generator only decides musical content; it does
// not score, plan or bypass the planner. Same spec + seed + version => same XML.

export const EXERCISE_GENERATOR_VERSION = 'exercise-generator-1.0.0';

export type ExerciseKind = 'rhythm' | 'arpeggio';
export type ExerciseHand = 'right' | 'left';
export type RhythmPatternId = 'quarter' | 'eighth' | 'eighth-rest' | 'dotted';
export type ArpeggioDirection = 'up' | 'down' | 'up-down';
export type ArpeggioQuality = 'major' | 'minor';
export type RootNote = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';

interface ExerciseCommon {
  seed: number;
  bpm: number;
  hand: ExerciseHand;
  timeSignature: [number, number];
  bars: 2 | 4 | 8;
  rhythmPattern: RhythmPatternId;
}

export interface RhythmExerciseSpec extends ExerciseCommon {
  kind: 'rhythm';
  pitchMode: 'fixed' | 'five-note';
}

export interface ArpeggioExerciseSpec extends ExerciseCommon {
  kind: 'arpeggio';
  root: RootNote;
  quality: ArpeggioQuality;
  direction: ArpeggioDirection;
  octaves: 1;
}

export type ExerciseSpec = RhythmExerciseSpec | ArpeggioExerciseSpec;

export interface GeneratedExercise {
  exerciseId: string;
  spec: ExerciseSpec;
  seed: number;
  generatorVersion: string;
  contentFingerprint: string;
  xml: string;
  summary: {
    kind: ExerciseKind;
    title: string;
    bars: number;
    noteCount: number;
    restCount: number;
    lowest: string | null;
    highest: string | null;
    bpm: number;
  };
}

export class ExerciseGeneratorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExerciseGeneratorError';
  }
}

const DIVISIONS = 480;
const STEPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'] as const;
const ALTERS = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0] as const;
const ROOT_PC: Record<RootNote, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const FIVE_NOTE_OFFSETS = [0, 2, 4, 5, 7];
const PATTERN_LABELS: Record<RhythmPatternId, string> = {
  quarter: '四分音符',
  eighth: '八分音符',
  'eighth-rest': '八分音符 + 休止',
  dotted: '附点节奏',
};

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

function pitchFromMidi(midi: number): { step: string; alter: number; octave: number; spelling: string } {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const step = STEPS[pc];
  const alter = ALTERS[pc];
  return { step, alter, octave, spelling: `${step}${alter === 1 ? '#' : ''}${octave}` };
}

function arpeggioMidi(spec: ArpeggioExerciseSpec, toneIndex: number): number {
  const rootPc = ROOT_PC[spec.root];
  const rootOctave = spec.hand === 'left' ? 3 : 4;
  const rootMidi = (rootOctave + 1) * 12 + rootPc;
  const third = spec.quality === 'major' ? 4 : 3;
  const tones = [0, third, 7, 12];
  if (spec.direction === 'up') return rootMidi + tones[toneIndex % 4];
  if (spec.direction === 'down') return rootMidi + tones[3 - (toneIndex % 4)];
  // up-down: root, third, fifth, octave, fifth, third (six-note cycle)
  const cycle = [0, third, 7, 12, 7, third];
  return rootMidi + cycle[toneIndex % cycle.length];
}

function rhythmPitch(spec: RhythmExerciseSpec, rand: () => number): number {
  const base = spec.hand === 'left' ? 48 : 60; // C3 / C4
  if (spec.pitchMode === 'fixed') return base;
  const offset = FIVE_NOTE_OFFSETS[Math.floor(rand() * FIVE_NOTE_OFFSETS.length)] ?? 0;
  return base + offset;
}

interface NoteSlot {
  midi: number | null;
  duration: number;
  type: 'quarter' | 'eighth' | 'half' | 'whole';
  dots: number;
}

function patternSlots(pattern: RhythmPatternId, beats: number, nextMidi: () => number): NoteSlot[] {
  const slots: NoteSlot[] = [];
  if (pattern === 'quarter') {
    for (let i = 0; i < beats; i += 1) slots.push({ midi: nextMidi(), duration: DIVISIONS, type: 'quarter', dots: 0 });
    return slots;
  }
  if (pattern === 'eighth') {
    for (let i = 0; i < beats * 2; i += 1) slots.push({ midi: nextMidi(), duration: DIVISIONS / 2, type: 'eighth', dots: 0 });
    return slots;
  }
  if (pattern === 'eighth-rest') {
    for (let i = 0; i < beats; i += 1) {
      slots.push({ midi: nextMidi(), duration: DIVISIONS / 2, type: 'eighth', dots: 0 });
      slots.push({ midi: null, duration: DIVISIONS / 2, type: 'eighth', dots: 0 });
    }
    return slots;
  }
  // dotted: two dotted-quarter + eighth groups per measure (only 4/4 is offered)
  for (let group = 0; group < 2; group += 1) {
    slots.push({ midi: nextMidi(), duration: DIVISIONS * 1.5, type: 'quarter', dots: 1 });
    slots.push({ midi: nextMidi(), duration: DIVISIONS / 2, type: 'eighth', dots: 0 });
  }
  return slots;
}

function validateSpec(spec: ExerciseSpec): { beats: number; beatType: number } {
  if (!Number.isInteger(spec.seed)) throw new ExerciseGeneratorError('INVALID_SEED', 'seed 必须是整数');
  if (!Number.isFinite(spec.bpm) || spec.bpm < 20 || spec.bpm > 300) {
    throw new ExerciseGeneratorError('INVALID_BPM', 'BPM 必须在 20–300 之间');
  }
  if (!['right', 'left'].includes(spec.hand)) {
    throw new ExerciseGeneratorError('INVALID_HAND', '生成练习只支持单手（右手或左手）');
  }
  if (![2, 4, 8].includes(spec.bars)) {
    throw new ExerciseGeneratorError('INVALID_BARS', '小节数必须是 2、4 或 8');
  }
  const [beats, beatType] = spec.timeSignature;
  if (![2, 3, 4].includes(beats) || beatType !== 4) {
    throw new ExerciseGeneratorError('INVALID_TIME_SIGNATURE', '拍号只支持 2/4、3/4、4/4');
  }
  if (spec.rhythmPattern === 'dotted' && beats !== 4) {
    throw new ExerciseGeneratorError('INVALID_PATTERN_FOR_METER', '附点节奏只支持 4/4');
  }
  if (spec.kind === 'arpeggio' && spec.octaves !== 1) {
    throw new ExerciseGeneratorError('INVALID_OCTAVES', '琶音第一版只支持一个八度');
  }
  return { beats, beatType };
}

function specTitle(spec: ExerciseSpec): string {
  if (spec.kind === 'rhythm') {
    return `节奏型 · ${PATTERN_LABELS[spec.rhythmPattern]} · ${spec.timeSignature[0]}/${spec.timeSignature[1]}`;
  }
  return `琶音 · ${spec.root}${spec.quality === 'major' ? '大' : '小'}三和弦 · ${spec.direction}`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function generateExercise(spec: ExerciseSpec): GeneratedExercise {
  const { beats } = validateSpec(spec);
  const rand = mulberry32(spec.seed);
  const handStaff = spec.hand === 'left' ? 2 : 1;
  let noteCount = 0;
  let restCount = 0;
  let lowest: string | null = null;
  let highest: string | null = null;
  let arpIndex = 0;

  const nextMidi = (): number => {
    if (spec.kind === 'arpeggio') return arpeggioMidi(spec, arpIndex++);
    return rhythmPitch(spec, rand);
  };

  const measuresXml: string[] = [];
  for (let bar = 1; bar <= spec.bars; bar += 1) {
    const slots = patternSlots(spec.rhythmPattern, beats, nextMidi);
    const total = slots.reduce((sum, slot) => sum + slot.duration, 0);
    const expected = beats * DIVISIONS;
    if (total !== expected) throw new ExerciseGeneratorError('INVALID_MEASURE_CAPACITY', `第 ${bar} 小节时值总和不等于拍号容量`);
    const notesXml = slots.map((slot) => {
      if (slot.midi === null) {
        restCount += 1;
        return `<note><rest/><duration>${slot.duration}</duration><voice>1</voice><type>${slot.type}</type>${slot.dots ? '<dot/>' : ''}<staff>${handStaff}</staff></note>`;
      }
      noteCount += 1;
      const pitch = pitchFromMidi(slot.midi);
      if (lowest === null || slot.midi < midiOf(lowest)) lowest = pitch.spelling;
      if (highest === null || slot.midi > midiOf(highest)) highest = pitch.spelling;
      return `<note><pitch><step>${pitch.step}</step>${pitch.alter ? `<alter>${pitch.alter}</alter>` : ''}<octave>${pitch.octave}</octave></pitch><duration>${slot.duration}</duration><voice>1</voice><type>${slot.type}</type>${slot.dots ? '<dot/>' : ''}<staff>${handStaff}</staff></note>`;
    }).join('');
    const attributes = bar === 1 ? `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>0</fifths><mode>major</mode></key><time><beats>${beats}</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>` : '';
    measuresXml.push(`<measure number="${bar}">${attributes}${notesXml}</measure>`);
  }

  const title = specTitle(spec);
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<score-partwise version="4.0">
  <work><work-title>${xmlEscape(title)}</work-title></work>
  <identification><creator type="composer">Rhythm Trainer 生成练习</creator><encoding><software>${EXERCISE_GENERATOR_VERSION}</software></encoding></identification>
  <part-list><score-part id="P1"><part-name>Generated Exercise</part-name></score-part></part-list>
  <part id="P1">
    ${measuresXml.join('\n    ')}
  </part>
</score-partwise>`;

  const identity = JSON.stringify({ spec, seed: spec.seed, generatorVersion: EXERCISE_GENERATOR_VERSION });
  return {
    exerciseId: `ex_${fnv1a(identity)}`,
    spec,
    seed: spec.seed,
    generatorVersion: EXERCISE_GENERATOR_VERSION,
    contentFingerprint: `exercise-v1:${fnv1a(xml)}`,
    xml,
    summary: {
      kind: spec.kind,
      title,
      bars: spec.bars,
      noteCount,
      restCount,
      lowest,
      highest,
      bpm: spec.bpm,
    },
  };
}

// Small helper used only for the low/high summary.
function midiOf(spelling: string): number {
  const match = /^([A-G])(#?)(-?\d+)$/.exec(spelling);
  if (!match) return 0;
  const step = match[1] as RootNote;
  return (Number(match[3]) + 1) * 12 + ROOT_PC[step] + (match[2] ? 1 : 0);
}
