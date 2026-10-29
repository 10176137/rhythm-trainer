import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

export const MEASURES_PER_SYSTEM = 4;

type XmlNode = Record<string, unknown>;
const xmlOptions = { preserveOrder: true, ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false };
const parser = new XMLParser(xmlOptions);
const builder = new XMLBuilder({ ...xmlOptions, suppressEmptyNode: true });
const children = (value: unknown): XmlNode[] => Array.isArray(value) ? value : [];
const text = (nodes: XmlNode[], tag: string): string => String(children(nodes.find((node) => tag in node)?.[tag]).find((node) => '#text' in node)?.['#text'] ?? '');
const element = (tag: string, value: number): XmlNode => ({ [tag]: [{ '#text': String(value) }] });

/** Layout-only XML: these invisible rest measures never enter the semantic
 * document, playback plan, score fingerprint, persisted score or assessment. */
export function prepareMeasureGrid(xml: string) {
  const document: XmlNode[] = parser.parse(xml);
  const score = children(document.find((node) => 'score-partwise' in node)?.['score-partwise']);
  const parts = score.filter((node) => 'part' in node).map((node) => children(node.part));
  const measureCount = Math.max(0, ...parts.map((part) => part.filter((node) => 'measure' in node).length));
  const slotCount = Math.ceil(measureCount / MEASURES_PER_SYSTEM) * MEASURES_PER_SYSTEM;
  let changed = false;
  for (const part of parts) {
    const measures = part.filter((node) => 'measure' in node);
    if (!measures.length || measures.length === slotCount) continue;
    let staves = 1;
    let durationBeats = 4;
    for (const measure of measures) for (const entry of children(measure.measure)) {
      if (!('attributes' in entry)) continue;
      const attributes = children(entry.attributes);
      if (text(attributes, 'staves')) staves = Number(text(attributes, 'staves'));
      const time = children(attributes.find((node) => 'time' in node)?.time);
      if (time.length) {
        let beats = 0;
        let sum = 0;
        for (const node of time) {
          if ('beats' in node) beats = text([node], 'beats').split('+').reduce((total, value) => total + Number(value), 0);
          if ('beat-type' in node) sum += beats * 4 / Number(text([node], 'beat-type'));
        }
        if (sum > 0 && Number.isFinite(sum)) durationBeats = sum;
      }
    }
    const duration = durationBeats * 480;
    for (let index = measures.length; index < slotCount; index += 1) {
      const content: XmlNode[] = [{ attributes: [element('divisions', 480)] }];
      for (let staff = 1; staff <= staves; staff += 1) {
        if (staff > 1) content.push({ backup: [element('duration', duration)] });
        content.push({
          note: [{ rest: [], ':@': { '@_measure': 'yes' } }, element('duration', duration), element('voice', staff), element('staff', staff)],
          ':@': { '@_print-object': 'no', '@_print-spacing': 'yes' },
        });
      }
      part.push({ measure: content, ':@': { '@_number': String(index + 1), '@_implicit': 'yes' } });
    }
    changed = true;
  }
  return { xml: changed ? builder.build(document) as string : xml, measureCount, slotCount };
}

/**
 * Four equal-width measure slots on every row, including the padded last row.
 * Source-file line/page breaks must not override this reading grid.
 */
export function applyMeasureGrid(osmd: Pick<OpenSheetMusicDisplay, 'EngravingRules'>): void {
  osmd.EngravingRules.StretchLastSystemLine = true;
  osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = MEASURES_PER_SYSTEM;
  osmd.EngravingRules.FixedMeasureWidth = false;
  osmd.EngravingRules.FixedMeasureWidthUseForPickupMeasures = true;
  osmd.EngravingRules.NewSystemAtXMLNewSystemAttribute = false;
  osmd.EngravingRules.NewSystemAtXMLNewPageAttribute = false;
  osmd.EngravingRules.NewPageAtXMLNewPageAttribute = false;
  osmd.EngravingRules.AutoGenerateMultipleRestMeasuresFromRestMeasures = false;
  osmd.EngravingRules.NewPartAndSystemAfterFinalBarline = false;
}

/** OSMD 2.2.1 fixes only the note area with FixedMeasureWidth. This scoped
 * adapter reserves clef/meter/barline space INSIDE each equal cell before the
 * native formatter draws notes, beams, ties, connectors and clickable anchors.
 * The builder override exists only during one synchronous render and is always
 * restored; other OSMD instances, including fixed-line playback, are unaffected. */
export function renderMeasureGrid(osmd: OpenSheetMusicDisplay, host: HTMLElement, MusicSystemBuilder: typeof import('opensheetmusicdisplay').MusicSystemBuilder): void {
  host.style.width = '';
  osmd.render();
  const measures = osmd.GraphicSheet.MeasureList.flatMap((vertical) => vertical.filter(Boolean));
  const minimumCell = Math.max(0, ...measures.map((measure) =>
    measure.minimumStaffEntriesWidth + measure.beginInstructionsWidth + measure.endInstructionsWidth));
  const lookAhead = Math.max(0, ...measures.map((measure) => measure.beginInstructionsWidth));
  const available = measures[0]?.ParentStaffLine.PositionAndShape.Size.width ?? 0;
  if (!available) return;
  // OSMD also reserves room for the following measure's courtesy instructions
  // when deciding whether a measure fits. Leave that room in the width budget.
  const required = minimumCell * MEASURES_PER_SYSTEM + lookAhead + 1;
  if (available < required) host.style.width = `${Math.ceil(host.clientWidth + (required - available) * 10 * osmd.Zoom)}px`;
  type Builder = {
    rules: OpenSheetMusicDisplay['EngravingRules'];
    currentSystemParams: { currentSystem: import('opensheetmusicdisplay').MusicSystem; currentSystemFixWidth: number; currentSystemVarWidth: number };
    stretchMusicSystem: (partEnd: boolean) => void;
    checkAndCreateExtraInstructionMeasure: (...args: unknown[]) => void;
  };
  const prototype = MusicSystemBuilder.prototype as unknown as Builder;
  const stretch = prototype.stretchMusicSystem;
  const courtesy = prototype.checkAndCreateExtraInstructionMeasure;
  prototype.checkAndCreateExtraInstructionMeasure = function (...args) {
    // Courtesy signatures are optional; the actual change is retained at the
    // beginning of the following measure instead of adding a fifth narrow cell.
    if (this.rules !== osmd.EngravingRules) courtesy.apply(this, args);
  };
  prototype.stretchMusicSystem = function (partEnd) {
    if (this.rules !== osmd.EngravingRules) return stretch.call(this, partEnd);
    const params = this.currentSystemParams;
    const lines = params.currentSystem.StaffLines;
    const width = lines[0].PositionAndShape.Size.width;
    const cell = width / MEASURES_PER_SYSTEM;
    for (const line of lines) for (const measure of line.Measures) {
      measure.minimumStaffEntriesWidth = cell - measure.beginInstructionsWidth - measure.endInstructionsWidth;
    }
    params.currentSystemVarWidth = width - params.currentSystemFixWidth;
    stretch.call(this, false);
  };
  try { osmd.render(); }
  finally {
    prototype.stretchMusicSystem = stretch;
    prototype.checkAndCreateExtraInstructionMeasure = courtesy;
  }
}
