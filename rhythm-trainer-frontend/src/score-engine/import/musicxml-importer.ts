import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  IMPORT_SCHEMA_VERSION,
  SCORE_ENGINE_VERSION,
  SUPPORT_PROFILE_VERSION,
  type BarlineInfo,
  type ClefInstruction,
  type ImportIssue,
  type ImportIssueCode,
  type ImportMusicXmlResult,
  type ImportOptions,
  type ImportReport,
  type ImportStatus,
  type KeySignature,
  type MeasureAttributes,
  type Pitch,
  type ScoreDocument,
  type ScoreEvent,
  type ScoreMeasure,
  type ScorePart,
  type ScoreSourceRef,
  type TieSpan,
  type TimeSignature,
  type TempoMark,
} from '../domain/types';
import {
  addBeat,
  compareBeat,
  fromMusicXmlDuration,
  isNegativeBeat,
  maxBeat,
  rational,
  subtractBeat,
  ZERO_BEAT,
  type RationalBeat,
} from '../domain/rational';

type OrderedNode = Record<string, unknown>;
type OrderedChildren = OrderedNode[];

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const NOTE_STEPS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
const STEP_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SUPPORTED_CLEF_SIGNS = new Set(['G', 'F']);
const TEMPO_CURVE_PATTERN = /(rit\.?|rall\.?|accel\.?|rubato|string\.?|poco\s+a\s+poco)/i;
const JUMP_PATTERN = /(d\.?\s*c\.?|d\.?\s*s\.?|coda|fine|to\s+coda)/i;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

class FatalImportError extends Error {
  constructor(
    readonly code: ImportIssueCode,
    message: string,
    readonly measureOrdinal?: number,
  ) {
    super(message);
    this.name = 'FatalImportError';
  }
}

function asChildren(value: unknown): OrderedChildren {
  return Array.isArray(value) ? (value as OrderedChildren) : [];
}

function textOf(children: OrderedChildren): string {
  const node = children.find((entry) => '#text' in entry);
  return node ? String(node['#text']) : '';
}

function findChild(children: OrderedChildren, tag: string): OrderedNode | undefined {
  return children.find((node) => tag in node);
}

function childValue(children: OrderedChildren, tag: string): string | undefined {
  const node = findChild(children, tag);
  return node ? textOf(asChildren(node[tag])) : undefined;
}

function childChildren(children: OrderedChildren, tag: string): OrderedChildren | undefined {
  const node = findChild(children, tag);
  return node ? asChildren(node[tag]) : undefined;
}

function attrsOf(node: OrderedNode): Record<string, unknown> {
  return (node[':@'] as Record<string, unknown> | undefined) ?? {};
}

function attr(node: OrderedNode, name: string): string {
  return String(attrsOf(node)[`@_${name}`] ?? '');
}

function numberValue(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function formatSpelling(step: string, alter: number, octave: number): string {
  if (alter === 0) return `${step}${octave}`;
  if (alter === 1) return `${step}#${octave}`;
  if (alter === -1) return `${step}b${octave}`;
  if (alter === 2) return `${step}##${octave}`;
  if (alter === -2) return `${step}bb${octave}`;
  return `${step}${alter > 0 ? '+' : ''}${alter}${octave}`;
}

function midiFromPitch(step: string, alter: number, octave: number): number | null {
  const value = (octave + 1) * 12 + STEP_SEMITONES[step] + alter;
  if (!Number.isInteger(value) || value < 0 || value > 127) return null;
  return value;
}

function accidentalToAlter(accidental: string): number {
  switch (accidental) {
    case 'sharp': return 1;
    case 'flat': return -1;
    case 'double-sharp':
    case 'sharp-sharp': return 2;
    case 'flat-flat':
    case 'double-flat': return -2;
    default: return 0;
  }
}

function createIssue(
  code: ImportIssueCode,
  message: string,
  severity: ImportIssue['severity'],
  blocksStrict: boolean,
  context: { measureOrdinal?: number; eventId?: string; xmlId?: string } = {},
): ImportIssue {
  return { code, message, severity, blocksStrict, ...context };
}

function signatureFingerprint(xmlText: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(xmlText)));
}

function makeReport(
  fingerprint: string,
  fileName: string,
  issues: ImportIssue[],
  counts: ImportReport['counts'],
  capabilities: string[],
  sourceFormat: ImportReport['sourceFormat'],
  formatVersion?: string,
): ImportReport {
  const hasError = issues.some((issue) => issue.severity === 'error');
  const strictAllowed = !hasError && !issues.some((issue) => issue.blocksStrict);
  let status: ImportStatus;
  if (hasError) status = 'REJECTED';
  else if (!strictAllowed) status = 'DISPLAY_ONLY';
  else if (issues.some((issue) => issue.severity === 'warning' || issue.severity === 'info')) {
    status = 'READY_WITH_WARNINGS';
  } else status = 'READY';
  return {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    parserVersion: SCORE_ENGINE_VERSION,
    supportProfileVersion: SUPPORT_PROFILE_VERSION,
    fingerprint,
    status,
    strictAllowed,
    sourceFileName: fileName,
    sourceFormat,
    formatVersion,
    counts: {
      ...counts,
      warningCount: issues.filter((issue) => issue.severity === 'warning' || issue.severity === 'info').length,
      errorCount: issues.filter((issue) => issue.severity === 'error').length,
    },
    issues,
    capabilities,
  };
}

function emptyCounts(): ImportReport['counts'] {
  return {
    partCount: 0, measureCount: 0, noteCount: 0, restCount: 0, chordNoteCount: 0,
    tieSpanCount: 0, graceCount: 0, cueCount: 0, warningCount: 0, errorCount: 0,
  };
}

function validateBoundary(xmlText: string, options: ImportOptions): {
  fileName: string;
  doctypePresent: boolean;
  fingerprint: string;
} {
  const fileName = options.fileName ?? 'score.musicxml';
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.mxl')) {
    throw new FatalImportError('unsupported_compressed_musicxml', '暂不支持 .mxl 压缩谱；请先解压为 .musicxml');
  }
  if (!lower.endsWith('.musicxml') && !lower.endsWith('.xml')) {
    throw new FatalImportError('unsupported_extension', '只接受 .musicxml 或 .xml 文件');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const byteLength = new TextEncoder().encode(xmlText).length;
  if (byteLength > maxBytes) {
    throw new FatalImportError('file_too_large', `文件超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 限制`);
  }
  if (/<!ENTITY/i.test(xmlText)) {
    throw new FatalImportError('xml_external_entity_disabled', '拒绝包含 XML 实体声明的文件（防止外部实体/XXE）');
  }
  const doctypeMatch = xmlText.match(/<!DOCTYPE[\s\S]*?>/i);
  const doctypePresent = Boolean(doctypeMatch);
  if (doctypeMatch && doctypeMatch[0].includes('[')) {
    throw new FatalImportError('xml_internal_subset_disabled', '拒绝包含内部 DTD 子集的 MusicXML 文件');
  }
  if (/<\s*xi:include/i.test(xmlText)) {
    throw new FatalImportError('xml_external_entity_disabled', '拒绝包含 XInclude 的 MusicXML 文件');
  }
  return { fileName, doctypePresent, fingerprint: signatureFingerprint(xmlText) };
}

function parseClefs(attributesChildren: OrderedChildren): ClefInstruction[] {
  const clefs: ClefInstruction[] = [];
  for (const node of attributesChildren.filter((entry) => 'clef' in entry)) {
    const clefChildren = asChildren(node.clef);
    const sign = childValue(clefChildren, 'sign') ?? 'G';
    const line = numberValue(childValue(clefChildren, 'line'), sign === 'F' ? 4 : 2);
    const numberAttr = attr(node, 'number');
    clefs.push({ staffNumber: numberAttr ? numberValue(numberAttr, 1) : 1, sign, line });
  }
  return clefs;
}

interface ParseContext {
  fingerprint: string;
  partId: string;
  issues: ImportIssue[];
  capabilities: Set<string>;
  counts: ImportReport['counts'];
  fileName: string;
}

interface NoteAnchor {
  event: ScoreEvent;
  onset: RationalBeat;
}

function eventEnd(event: ScoreEvent): RationalBeat {
  return addBeat(event.onsetBeat, event.durationBeat);
}

function pitchKey(pitch: Pitch, staffNumber: number, voiceId: string): string {
  return `${pitch.spelling}|${staffNumber}|${voiceId}`;
}

function resolveTies(part: ScorePart, ctx: ParseContext): TieSpan[] {
  const events = part.measures
    .flatMap((measure) => measure.events)
    .filter((event) => event.kind === 'note' && event.pitch)
    .slice()
    .sort((a, b) => {
      const byOnset = compareBeat(a.onsetBeat, b.onsetBeat);
      if (byOnset !== 0) return byOnset;
      return a.source.measureOrdinal - b.source.measureOrdinal || a.source.sourceOrdinal - b.source.sourceOrdinal;
    });
  const open = new Map<string, { event: ScoreEvent; span?: TieSpan }>();
  const spans: TieSpan[] = [];
  const warnedTiedNotation = new Set<string>();

  for (const event of events) {
    const pitch = event.pitch!;
    const key = pitchKey(pitch, event.source.staffNumber, event.source.voiceId ?? '1');

    if ((event.tiedStart || event.tiedStop) && !event.tieStart && !event.tieStop && !warnedTiedNotation.has(event.id)) {
      warnedTiedNotation.add(event.id);
      ctx.issues.push(createIssue(
        'tied_notation_without_sound_tie',
        '存在 <tied> 记谱连音线但没有对应的 <tie> 音响连接；不作为声音延音处理',
        'warning', false,
        { measureOrdinal: event.source.measureOrdinal, eventId: event.id, xmlId: event.source.xmlId },
      ));
    }

    if (event.tieStop) {
      const entry = open.get(key);
      if (!entry) {
        ctx.issues.push(createIssue(
          'orphan_tie_stop',
          'tie stop 没有可匹配的 tie start；无法可靠判断该音是否重新起音',
          'warning', true,
          { measureOrdinal: event.source.measureOrdinal, eventId: event.id, xmlId: event.source.xmlId },
        ));
      } else {
        let span = entry.span;
        if (!span) {
          span = {
            id: `tie:${ctx.fingerprint.slice(0, 12)}:${part.id}:${entry.event.source.measureOrdinal}:${entry.event.source.sourceOrdinal}`,
            pitchKey: key,
            eventIds: [entry.event.id],
            startBeat: entry.event.onsetBeat,
            endBeat: eventEnd(entry.event),
          };
          spans.push(span);
          entry.span = span;
          entry.event.tieSpanId = span.id;
        }
        span.eventIds = [...span.eventIds, event.id];
        span.endBeat = maxBeat(span.endBeat, eventEnd(event));
        event.tieSpanId = span.id;
        if (event.tieStart) {
          open.set(key, { event, span });
        } else {
          open.delete(key);
        }
      }
    } else if (event.tieStart) {
      if (!open.has(key)) open.set(key, { event });
    }
  }

  for (const [key, entry] of open) {
    ctx.issues.push(createIssue(
      'orphan_tie_start',
      `tie start（${key.split('|')[0]}）没有后续 tie stop；结束音时值不确定`,
      'warning', true,
      { measureOrdinal: entry.event.source.measureOrdinal, eventId: entry.event.id, xmlId: entry.event.source.xmlId },
    ));
  }

  ctx.counts.tieSpanCount = spans.length;
  if (spans.length > 0) ctx.capabilities.add('ties');
  return spans;
}

function parsePart(
  partNode: OrderedNode,
  partOrdinal: number,
  partNames: Map<string, string>,
  ctx: ParseContext,
): ScorePart {
  const partId = attr(partNode, 'id') || `P${partOrdinal}`;
  const measureNodes = asChildren(partNode.part).filter((node) => 'measure' in node);
  if (!measureNodes.length) {
    throw new FatalImportError('missing_measures', `part ${partId} 没有小节`);
  }
  const measures: ScoreMeasure[] = [];
  let divisions: number | undefined;
  let time: TimeSignature = { beats: 4, beatType: 4 };
  let key: KeySignature = { fifths: 0, mode: 'major' };
  let staves = 1;
  let clefs: ClefInstruction[] = [];
  let measureStartBeat = ZERO_BEAT;
  let hasSeenAnyNote = false;

  const setAttributes = (attributesChildren: OrderedChildren, measureOrdinal: number, midMeasure: boolean) => {
    const divisionsNode = findChild(attributesChildren, 'divisions');
    if (divisionsNode) {
      const next = numberValue(childValue(attributesChildren, 'divisions'), NaN);
      if (!isPositiveInteger(next)) {
        throw new FatalImportError('invalid_divisions', 'divisions 必须是正整数', measureOrdinal);
      }
      divisions = next;
    }
    const timeNode = findChild(attributesChildren, 'time');
    if (timeNode) {
      const timeChildren = asChildren(timeNode.time);
      const nextBeats = numberValue(childValue(timeChildren, 'beats'), NaN);
      const nextBeatType = numberValue(childValue(timeChildren, 'beat-type'), NaN);
      if (isPositiveInteger(nextBeats) && isPositiveInteger(nextBeatType)) {
        time = { beats: nextBeats, beatType: nextBeatType };
      } else {
        ctx.issues.push(createIssue('invalid_duration', '拍号无效，保留前一个有效拍号', 'warning', true, { measureOrdinal }));
      }
    }
    const keyNode = findChild(attributesChildren, 'key');
    if (keyNode) {
      const keyChildren = asChildren(keyNode.key);
      key = {
        fifths: numberValue(childValue(keyChildren, 'fifths'), key.fifths),
        mode: childValue(keyChildren, 'mode') || key.mode,
      };
    }
    const stavesNode = findChild(attributesChildren, 'staves');
    if (stavesNode) {
      const next = numberValue(childValue(attributesChildren, 'staves'), staves);
      if (isPositiveInteger(next)) staves = next;
    }
    const nextClefs = parseClefs(attributesChildren);
    if (nextClefs.length) {
      // A <clef number="1"> change must not erase the carried clef for staff 2
      // (and vice versa). Scores that switch one staff's clef mid-system are
      // common in piano notation; merge by staff number instead of replacing.
      const byStaff = new Map(clefs.map((clef) => [clef.staffNumber, clef]));
      for (const clef of nextClefs) byStaff.set(clef.staffNumber, clef);
      clefs = [...byStaff.values()]
        .sort((a, b) => a.staffNumber - b.staffNumber)
        .map((clef) => ({ ...clef }));
      for (const clef of nextClefs) {
        if (!SUPPORTED_CLEF_SIGNS.has(clef.sign)) {
          ctx.capabilities.add('unsupported_clef');
          ctx.issues.push(createIssue(
            'unsupported_clef',
            `暂不支持 ${clef.sign}${clef.line} 谱号；首版严格练习只支持 G2/F4`,
            'warning', true, { measureOrdinal },
          ));
        }
      }
    }
    const transposeNode = findChild(attributesChildren, 'transpose');
    if (transposeNode) {
      const chromatic = numberValue(childValue(asChildren(transposeNode.transpose), 'chromatic'), 0);
      if (chromatic !== 0) {
        ctx.capabilities.add('transpose');
        ctx.issues.push(createIssue(
          'unsupported_transpose',
          `暂不支持移调乐器（transpose ${chromatic} 半音）；严格计时需要移调后的音高`,
          'warning', true, { measureOrdinal },
        ));
      }
    }
    if (midMeasure) {
      ctx.issues.push(createIssue(
        'mid_measure_attributes',
        '小节中途改变 divisions/拍号/调号/谱号；严格计分不支持',
        'warning', true, { measureOrdinal },
      ));
    }
  };

  measureNodes.forEach((measureNode, index) => {
    const measureOrdinal = index + 1;
    const printedNumber = attr(measureNode, 'number') || undefined;
    const implicit = attr(measureNode, 'implicit').toLowerCase() === 'yes';
    const measureChildren = asChildren(measureNode.measure);
    let attributesAtStart: MeasureAttributes = {
      divisions: divisions ?? 1,
      time: { ...time },
      key: { ...key },
      staves,
      clefs: clefs.map((clef) => ({ ...clef })),
    };
    let cursor = ZERO_BEAT;
    let contentEnd = ZERO_BEAT;
    let sourceOrdinal = 0;
    let hasEvents = false;
    const anchors = new Map<string, NoteAnchor>();
    const events: ScoreEvent[] = [];
    const barlines: BarlineInfo[] = [];
    const tempoMarks: TempoMark[] = [];
    const measureCapabilities = new Set<string>();

    for (const node of measureChildren) {
      if ('attributes' in node) {
        const midMeasure = hasEvents;
        setAttributes(asChildren(node.attributes), measureOrdinal, midMeasure);
        if (!midMeasure) {
          attributesAtStart = {
            divisions: divisions ?? attributesAtStart.divisions,
            time: { ...time },
            key: { ...key },
            staves,
            clefs: clefs.map((clef) => ({ ...clef })),
          };
        }
        continue;
      }

      if ('direction' in node) {
        const directionChildren = asChildren(node.direction);
        const directionType = childChildren(directionChildren, 'direction-type') ?? [];
        const metronome = findChild(directionType, 'metronome');
        if (metronome) {
          const bpm = numberValue(childValue(asChildren(metronome.metronome), 'per-minute'), NaN);
          if (Number.isFinite(bpm)) tempoMarks.push({ measureOrdinal, beat: addBeat(measureStartBeat, cursor), bpm, kind: 'metronome' });
        }
        const sound = findChild(directionChildren, 'sound');
        if (sound) {
          const bpm = numberValue(attr(sound, 'tempo'), NaN);
          if (Number.isFinite(bpm)) tempoMarks.push({ measureOrdinal, beat: addBeat(measureStartBeat, cursor), bpm, kind: 'sound' });
          if (attr(sound, 'dacapo') || attr(sound, 'dalsegno') || attr(sound, 'tocoda') || attr(sound, 'fine')) {
            ctx.capabilities.add('repeat');
            ctx.issues.push(createIssue(
              'unsupported_repeat_structure',
              '检测到 D.C./D.S./Coda/Fine 跳转；首版不展开播放顺序，禁止严格计时',
              'warning', true, { measureOrdinal },
            ));
          }
        }
        const words = childValue(directionType, 'words') ?? '';
        if (TEMPO_CURVE_PATTERN.test(words)) {
          ctx.capabilities.add('tempo_curve');
          ctx.issues.push(createIssue(
            'unsupported_tempo_curve',
            `检测到速度曲线/文字速度（${words}）；固定 BPM 测验不能可靠执行该语义`,
            'warning', true, { measureOrdinal },
          ));
        }
        if (JUMP_PATTERN.test(words)) {
          ctx.capabilities.add('repeat');
          ctx.issues.push(createIssue(
            'unsupported_repeat_structure',
            `检测到跳转/反复文字（${words}）；首版不展开，禁止严格计时`,
            'warning', true, { measureOrdinal },
          ));
        }
        continue;
      }

      if ('barline' in node) {
        const barlineChildren = asChildren(node.barline);
        const barline: BarlineInfo = { location: attr(node, 'location') || undefined };
        const barStyle = childValue(barlineChildren, 'bar-style');
        if (barStyle) barline.barStyle = barStyle;
        const repeat = findChild(barlineChildren, 'repeat');
        if (repeat) {
          const direction = attr(repeat, 'direction') === 'forward' ? 'forward' : 'backward';
          barline.repeat = {
            direction,
            ...(attr(repeat, 'times') ? { times: numberValue(attr(repeat, 'times'), 2) } : {}),
            ...(attr(repeat, 'after-jump') === 'yes' ? { afterJump: true } : {}),
          };
        }
        const ending = findChild(barlineChildren, 'ending');
        if (ending) {
          const type = attr(ending, 'type');
          if (type === 'start' || type === 'stop' || type === 'discontinue') {
            barline.ending = { type, ...(attr(ending, 'number') ? { number: attr(ending, 'number') } : {}) };
          }
        }
        barlines.push(barline);
        if (barline.repeat || barline.ending) {
          ctx.capabilities.add('repeat');
          ctx.issues.push(createIssue(
            'unsupported_repeat_structure',
            '检测到 repeat/ending 记号；首版不展开播放顺序，禁止严格计时',
            'warning', true, { measureOrdinal },
          ));
        }
        continue;
      }

      if ('backup' in node) {
        if (divisions === undefined) {
          throw new FatalImportError('missing_divisions', 'backup 之前没有 divisions，无法换算音乐时间', measureOrdinal);
        }
        const units = numberValue(childValue(asChildren(node.backup), 'duration'), NaN);
        if (!Number.isFinite(units) || units < 0) {
          ctx.issues.push(createIssue('invalid_duration', 'backup duration 无效', 'warning', true, { measureOrdinal }));
          continue;
        }
        cursor = subtractBeat(cursor, fromMusicXmlDuration(units, divisions));
        if (isNegativeBeat(cursor)) {
          ctx.issues.push(createIssue(
            'invalid_measure_cursor',
            'backup 将 cursor 移动到小节起点之前；已限制到 0',
            'warning', true, { measureOrdinal },
          ));
          cursor = ZERO_BEAT;
        }
        continue;
      }

      if ('forward' in node) {
        if (divisions === undefined) {
          throw new FatalImportError('missing_divisions', 'forward 之前没有 divisions，无法换算音乐时间', measureOrdinal);
        }
        const units = numberValue(childValue(asChildren(node.forward), 'duration'), NaN);
        if (!Number.isFinite(units) || units < 0) {
          ctx.issues.push(createIssue('invalid_duration', 'forward duration 无效', 'warning', true, { measureOrdinal }));
          continue;
        }
        cursor = addBeat(cursor, fromMusicXmlDuration(units, divisions));
        contentEnd = maxBeat(contentEnd, cursor);
        continue;
      }

      if (!('note' in node)) continue;

      hasEvents = true;
      sourceOrdinal += 1;
      hasSeenAnyNote = true;
      const noteChildren = asChildren(node.note);
      const isChord = Boolean(findChild(noteChildren, 'chord'));
      const isRest = Boolean(findChild(noteChildren, 'rest'));
      const grace = Boolean(findChild(noteChildren, 'grace'));
      const cue = Boolean(findChild(noteChildren, 'cue'));
      const staffNumber = numberValue(childValue(noteChildren, 'staff'), 1);
      const voiceId = childValue(noteChildren, 'voice') || '1';
      const anchorKey = `${staffNumber}:${voiceId}`;
      const anchor = anchors.get(anchorKey);
      let durationBeat = ZERO_BEAT;
      if (!grace) {
        const raw = childValue(noteChildren, 'duration');
        if (raw !== undefined) {
          const durationUnits = Number(raw);
          if (!Number.isFinite(durationUnits) || durationUnits < 0) {
            throw new FatalImportError('invalid_duration', 'note duration 必须是有限非负数', measureOrdinal);
          }
          if (divisions === undefined) {
            throw new FatalImportError('missing_divisions', 'note duration 之前没有 divisions，无法换算音乐时间', measureOrdinal);
          }
          durationBeat = fromMusicXmlDuration(durationUnits, divisions);
        } else {
          ctx.issues.push(createIssue(
            'missing_note_duration',
            '音符缺少 <duration>；拍位无法可靠推导',
            'warning', true, { measureOrdinal },
          ));
        }
      }

      let onsetLocal: RationalBeat;
      let chordGroupId: string | undefined;
      if (isChord) {
        if (!anchor || isRest) {
          ctx.issues.push(createIssue(
            'invalid_chord_anchor',
            '<chord/> 没有同 voice/staff 的合法基音；该和弦不能可靠对齐',
            'warning', true, { measureOrdinal },
          ));
          onsetLocal = cursor;
        } else {
          onsetLocal = anchor.onset;
          chordGroupId = anchor.event.chordGroupId ?? `chord:${anchor.event.id}`;
          if (!anchor.event.chordGroupId) anchor.event.chordGroupId = chordGroupId;
          ctx.counts.chordNoteCount += 1;
          measureCapabilities.add('chords');
        }
      } else {
        onsetLocal = cursor;
        if (isRest) {
          anchors.delete(anchorKey);
        }
        if (!isChord && !isRest && !grace) {
          anchors.set(anchorKey, { event: null as unknown as ScoreEvent, onset: onsetLocal });
        }
      }

      const id = `${ctx.fingerprint.slice(0, 16)}:${partId}:m${measureOrdinal}:e${sourceOrdinal}`;
      const source: ScoreSourceRef = {
        partId,
        measureOrdinal,
        printedMeasureNumber: printedNumber,
        voiceId,
        staffNumber,
        xmlId: attr(node, 'id') || undefined,
        sourceOrdinal,
      };

      let pitch: Pitch | undefined;
      if (!isRest) {
        const pitchNode = findChild(noteChildren, 'pitch');
        if (!pitchNode) {
          ctx.issues.push(createIssue(
            'unrepresentable_pitch',
            '音符没有 <pitch>（非休止符）；只能保留为不可评分事件',
            'warning', true, { measureOrdinal, eventId: id, xmlId: source.xmlId },
          ));
        } else {
          const pitchChildren = asChildren(pitchNode.pitch);
          const step = childValue(pitchChildren, 'step') ?? '';
          const octave = numberValue(childValue(pitchChildren, 'octave'), NaN);
          const accidental = childValue(noteChildren, 'accidental') ?? '';
          const alterText = childValue(pitchChildren, 'alter');
          const alter = alterText !== undefined ? Number(alterText) : accidentalToAlter(accidental);
          if (!NOTE_STEPS.has(step) || !Number.isFinite(octave) || !Number.isFinite(alter)) {
            ctx.issues.push(createIssue(
              'unrepresentable_pitch',
              '音高 step/octave/alter 缺失或非法；该事件不能进入严格音高目标',
              'warning', true, { measureOrdinal, eventId: id, xmlId: source.xmlId },
            ));
          } else {
            const midiNote = midiFromPitch(step, alter, octave);
            pitch = { step: step as Pitch['step'], alter, octave, midiNote, spelling: formatSpelling(step, alter, octave) };
            if (midiNote === null) {
              ctx.capabilities.add('microtone');
              ctx.issues.push(createIssue(
                'unrepresentable_pitch',
                `音高 ${pitch.spelling} 不能被当前 MIDI 模型无损表示`,
                'warning', true, { measureOrdinal, eventId: id, xmlId: source.xmlId },
              ));
            }
          }
        }
      }

      const tieTypes = new Set(
        noteChildren.filter((entry) => 'tie' in entry).map((entry) => attr(entry, 'type')),
      );
      const tiedTypes = new Set(
        noteChildren.filter((entry) => 'tied' in entry).map((entry) => attr(entry, 'type')),
      );
      const dots = noteChildren.filter((entry) => 'dot' in entry).length;
      const notatedType = childValue(noteChildren, 'type');
      const timeModificationNode = findChild(noteChildren, 'time-modification');
      let timeModification: ScoreEvent['timeModification'];
      if (timeModificationNode) {
        const tm = asChildren(timeModificationNode['time-modification']);
        const actualNotes = numberValue(childValue(tm, 'actual-notes'), NaN);
        const normalNotes = numberValue(childValue(tm, 'normal-notes'), NaN);
        if (isPositiveInteger(actualNotes) && isPositiveInteger(normalNotes)) {
          timeModification = { actualNotes, normalNotes };
          measureCapabilities.add('tuplets');
        }
      }
      const articulationsNode = findChild(noteChildren, 'articulations');
      const articulations = articulationsNode
        ? asChildren(articulationsNode.articulations).map((entry) => Object.keys(entry).find((key) => key !== ':@')).filter((key): key is string => Boolean(key))
        : [];
      const lyricNode = findChild(noteChildren, 'lyric');
      const lyricText = lyricNode ? childValue(asChildren(lyricNode.lyric), 'text') : undefined;
      const event: ScoreEvent = {
        id,
        kind: isRest ? 'rest' : 'note',
        source,
        onsetBeat: addBeat(measureStartBeat, onsetLocal),
        durationBeat,
        notatedType,
        dots,
        pitch,
        chordGroupId,
        tieStart: tieTypes.has('start'),
        tieStop: tieTypes.has('stop'),
        tiedStart: tiedTypes.has('start'),
        tiedStop: tiedTypes.has('stop'),
        isGrace: grace,
        isCue: cue,
        lyricText,
        articulations,
        capabilities: [...measureCapabilities],
        timeModification,
      };
      if (grace) {
        ctx.counts.graceCount += 1;
        ctx.capabilities.add('grace');
        ctx.issues.push(createIssue('unsupported_grace', '检测到 grace note；首版不作为严格起音目标', 'warning', true, { measureOrdinal, eventId: id, xmlId: source.xmlId }));
      }
      if (cue) {
        ctx.counts.cueCount += 1;
        ctx.capabilities.add('cue');
        ctx.issues.push(createIssue('unsupported_cue', '检测到 cue note；首版不作为严格演奏目标', 'warning', true, { measureOrdinal, eventId: id, xmlId: source.xmlId }));
      }
      events.push(event);

      if (isRest) ctx.counts.restCount += 1;
      else ctx.counts.noteCount += 1;

      if (!isChord) {
        if (!isRest && !grace) {
          const anchorEntry = anchors.get(anchorKey);
          if (anchorEntry && !anchorEntry.event) anchorEntry.event = event;
        }
        if (!grace) {
          cursor = addBeat(cursor, durationBeat);
          contentEnd = maxBeat(contentEnd, cursor);
        }
        contentEnd = maxBeat(contentEnd, addBeat(onsetLocal, durationBeat));
      }
    }

    const nominal = rational(time.beats * 4, time.beatType);
    let effective = nominal;
    if (compareBeat(contentEnd, nominal) > 0) {
      ctx.issues.push(createIssue(
        'duration_out_of_measure',
        `小节内容超过名义长度（${contentEnd.numerator}/${contentEnd.denominator} > ${nominal.numerator}/${nominal.denominator} 拍）`,
        'warning', true, { measureOrdinal },
      ));
      effective = contentEnd;
    } else if (implicit) {
      effective = contentEnd;
    } else if (compareBeat(contentEnd, nominal) < 0) {
      ctx.issues.push(createIssue(
        'measure_underfull',
        '小节内容短于拍号名义长度；按完整小节推进下一小节',
        'warning', false, { measureOrdinal },
      ));
    }
    if (compareBeat(effective, ZERO_BEAT) <= 0) {
      ctx.issues.push(createIssue(
        'invalid_measure_cursor',
        '小节有效长度为零；使用拍号名义长度继续',
        'warning', true, { measureOrdinal },
      ));
      effective = nominal;
    }

    measures.push({
      ordinal: measureOrdinal,
      printedNumber,
      implicit,
      startBeat: measureStartBeat,
      durationBeat: effective,
      attributes: {
        ...attributesAtStart,
        divisions: divisions ?? attributesAtStart.divisions,
        staves,
        clefs: clefs.map((clef) => ({ ...clef })),
      },
      events,
      barlines,
      tempoMarks,
      capabilities: [...measureCapabilities],
    });
    measureStartBeat = addBeat(measureStartBeat, effective);
  });

  const part: ScorePart = {
    id: partId,
    name: partNames.get(partId) ?? partId,
    staves,
    measures,
  };
  const ties = resolveTies(part, ctx);
  if (ties.length) ctx.capabilities.add('ties');
  for (const measure of measures) {
    for (const event of measure.events) {
      for (const capability of event.capabilities) ctx.capabilities.add(capability);
    }
  }
  if (staves > 1) ctx.capabilities.add('multi_staff');
  if (measures.some((measure) => measure.events.some((event) => event.source.voiceId !== '1'))) {
    ctx.capabilities.add('multi_voice');
  }
  if (!hasSeenAnyNote) {
    ctx.issues.push(createIssue('no_playable_notes', `part ${partId} 没有音符`, 'warning', false, { measureOrdinal: 1 }));
  }
  // Tie spans need to survive the part boundary; attach them to a temporary
  // property is avoided by returning them from the caller.
  (part as ScorePart & { tieSpans?: TieSpan[] }).tieSpans = ties;
  return part;
}

/** Parses a MusicXML partwise string. Pure: no time, DOM, React, OSMD, fs, MIDI. */
export function importMusicXml(xmlText: string, options: ImportOptions = {}): ImportMusicXmlResult {
  const issues: ImportIssue[] = [];
  const capabilities = new Set<string>();
  const counts = emptyCounts();
  let fileName = options.fileName ?? 'score.musicxml';
  let fingerprint = signatureFingerprint(xmlText);
  let doctypePresent = false;

  try {
    const boundary = validateBoundary(xmlText, options);
    fileName = boundary.fileName;
    fingerprint = boundary.fingerprint;
    doctypePresent = boundary.doctypePresent;

    const validation = XMLValidator.validate(xmlText);
    if (validation !== true) {
      const detail = typeof validation === 'object' && validation?.err
        ? `${validation.err.code}: ${validation.err.msg}（line ${validation.err.line}）`
        : 'XML 不是良构文档';
      throw new FatalImportError('invalid_xml', `XML 解析失败：${detail}`);
    }

    let parsed: OrderedChildren;
    try {
      parsed = parser.parse(xmlText) as OrderedChildren;
    } catch (error) {
      throw new FatalImportError('invalid_xml', `XML 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const rootNode = parsed.find((node) => 'score-partwise' in node);
    if (!rootNode) {
      if (parsed.some((node) => 'score-timewise' in node)) {
        throw new FatalImportError(
          'unsupported_score_timewise',
          '暂不支持 score-timewise；请转换为 score-partwise 后重试',
        );
      }
      throw new FatalImportError('unsupported_root', '根元素必须是 score-partwise');
    }
    const rootChildren = asChildren(rootNode['score-partwise']);
    const partNodes = rootChildren.filter((node) => 'part' in node);
    if (!partNodes.length) throw new FatalImportError('missing_parts', 'MusicXML 中没有 <part>');

    const partList = rootChildren.find((node) => 'part-list' in node);
    const partNames = new Map<string, string>();
    if (partList) {
      for (const scorePart of asChildren(partList['part-list']).filter((node) => 'score-part' in node)) {
        const id = attr(scorePart, 'id');
        const name = childValue(asChildren(scorePart['score-part']), 'part-name') ?? id;
        if (id) partNames.set(id, name);
      }
    }
    const workNode = rootChildren.find((node) => 'work' in node);
    const workTitle = (workNode && childValue(asChildren(workNode.work), 'work-title')) || fileName.replace(/\.[^.]+$/, '');
    const identification = rootChildren.find((node) => 'identification' in node);
    const creators = identification
      ? asChildren(identification.identification).filter((node) => 'creator' in node)
      : [];
    const composerNode = creators.find((node) => attr(node, 'type') === 'composer') ?? creators[0];
    const composer = composerNode ? textOf(asChildren(composerNode.creator)) : '';
    const version = attr(rootNode, 'version') || undefined;

    const ctx: ParseContext = {
      fingerprint, partId: '', issues, capabilities, counts, fileName,
    };
    const parts: ScorePart[] = [];
    partNodes.forEach((partNode, index) => {
      const part = parsePart(partNode, index + 1, partNames, ctx);
      parts.push(part);
    });
    if (partNodes.length > 1) {
      capabilities.add('multiple_parts');
      issues.push(createIssue(
        'multiple_parts',
        `检测到 ${partNodes.length} 个 part；当前产品界面仍以钢琴双谱表为主，请确认手别映射`,
        'info', false, { measureOrdinal: 1 },
      ));
    }

    const playableNotes = parts.flatMap((part) => part.measures.flatMap((measure) => measure.events))
      .filter((event) => event.kind === 'note');
    if (!playableNotes.length) throw new FatalImportError('no_playable_notes', '乐谱中没有可演奏的音符');
    const measureCount = Math.max(...parts.map((part) => part.measures.length));
    counts.partCount = parts.length;
    counts.measureCount = measureCount;

    const tieSpans: TieSpan[] = parts.flatMap((part) => (part as ScorePart & { tieSpans?: TieSpan[] }).tieSpans ?? []);
    for (const part of parts) {
      delete (part as ScorePart & { tieSpans?: TieSpan[] }).tieSpans;
    }
    for (const issue of issues) {
      if (issue.code === 'unsupported_clef' || issue.code === 'unsupported_transpose' || issue.code === 'unrepresentable_pitch') {
        capabilities.add(issue.code);
      }
    }
    const capabilityList = [...capabilities].sort();
    const document: ScoreDocument = {
      schemaVersion: IMPORT_SCHEMA_VERSION,
      parserVersion: SCORE_ENGINE_VERSION,
      supportProfileVersion: SUPPORT_PROFILE_VERSION,
      fingerprint,
      workTitle,
      composer,
      source: { format: 'musicxml-partwise', xmlVersion: version, doctypePresent },
      parts,
      tieSpans,
      tempoMarks: parts.flatMap((part) => part.measures.flatMap((measure) => measure.tempoMarks)),
      capabilities: capabilityList,
      strictAllowed: !issues.some((issue) => issue.severity === 'error' || issue.blocksStrict),
    };
    return {
      scoreDocument: document,
      importReport: makeReport(fingerprint, fileName, issues, counts, capabilityList, 'musicxml-partwise', version),
    };
  } catch (error) {
    if (error instanceof FatalImportError) {
      issues.push(createIssue(error.code, error.message, 'error', true, { measureOrdinal: error.measureOrdinal }));
      return {
        importReport: makeReport(fingerprint, fileName, issues, counts, [...capabilities], 'musicxml-partwise', undefined),
      };
    }
    throw error;
  }
}
