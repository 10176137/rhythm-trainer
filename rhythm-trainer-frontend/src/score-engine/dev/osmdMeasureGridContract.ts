/** Browser contract for the pinned OSMD 2.2.1 grid adapter. No engine/session. */
import { OpenSheetMusicDisplay, MusicSystemBuilder } from 'opensheetmusicdisplay';
import { applyMeasureGrid, prepareMeasureGrid, renderMeasureGrid } from '../../components/osmdEngraving';
import { importScoreText } from '../../features/score/scoreImport';
import { timelineHitNoteIds } from '../../features/practice/scoreHighlightFeedback';
import { fixedLineGroupHighlights } from '../../features/practice/fixedLineFeedback';
import denseScale from './fixtures/grid-dense-scale.musicxml?raw';
import leftFiveFinger from './fixtures/grid-left-five-finger.musicxml?raw';
import octaveShifts from '../../features/score/fixtures/octave-shifts.musicxml?raw';
import { OsmdScoreViewAdapter } from '../view/score-view-adapter';
import sample from '../../features/score/fixtures/c-major-practice.musicxml?raw';

// Hand-authored two-attack fixture, independent of the exercise generator.
const triads = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note><note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note><note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note><note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note><note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note></measure></part></score-partwise>`;

const sourceBars = [...sample.matchAll(/<measure\b[\s\S]*?<\/measure>/g)].map((match) => match[0]);
function score(count: number) {
  return sample.replace(/<measure\b[\s\S]*<\/measure>/, Array.from({ length: count }, (_, index) =>
    sourceBars[index === 0 ? 0 : 1 + (index - 1) % 3].replace(/number="\d+"/, `number="${index + 1}"`),
  ).join(''));
}
const cases = [
  ...[1, 4, 5, 6, 7, 9].map((count) => ({ name: `${count} 小节 / 1200px`, xml: score(count), width: 1200, zoom: 1 })),
  { name: '窄窗口 / 放大 130%', xml: score(5), width: 760, zoom: 1.3 },
  { name: '宽窗口 / 9 小节', xml: score(9), width: 1510, zoom: 1 },
  { name: '来源文件强制换行仍按四列', xml: score(6).replace('<measure number="3">', '<measure number="3"><print new-system="yes"/>'), width: 1200, zoom: 1 },
  { name: '跨行调号与拍号说明', xml: score(5).replace('<measure number="5">', `<measure number="5">${sourceBars[0].match(/<attributes>[\s\S]*?<\/attributes>/)![0]}`), width: 1200, zoom: 1 },
  { name: '双手密集音阶 / F 大调', xml: denseScale, width: 760, zoom: 1.3 },
  { name: '单独低音谱表 / G 大调', xml: leftFiveFinger, width: 860, zoom: 1 },
  { name: '高低八度记号 / 保留实际 MIDI 与音符定位', xml: octaveShifts, width: 1200, zoom: 1 },
  { name: '和弦多按错音 / 不显示整组成功', xml: triads, width: 1200, zoom: 1 },
];
const status = document.getElementById('status')!;
const preview = document.getElementById('preview')!;
const results = document.getElementById('results')!;
function assert(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
const prototype = MusicSystemBuilder.prototype as unknown as { stretchMusicSystem: unknown; checkAndCreateExtraInstructionMeasure: unknown };
const nativeStretch = prototype.stretchMusicSystem;
const nativeCourtesy = prototype.checkAndCreateExtraInstructionMeasure;

async function run() {
  let passed = 0;
  for (const entry of cases) {
    const wrapper = document.createElement('div');
    wrapper.style.width = `${entry.width}px`;
    wrapper.className = 'scratch';
    const host = document.createElement('div');
    wrapper.append(host);
    document.body.append(wrapper);
    try {
      const grid = prepareMeasureGrid(entry.xml);
      const original = importScoreText(entry.xml, 'grid-contract.musicxml').doc!.engine!;
      const osmd = new OpenSheetMusicDisplay(host, { autoResize: false, backend: 'svg', drawTitle: false, drawComposer: false, drawCredits: false, drawPartNames: false, drawPartAbbreviations: false, drawMeasureNumbers: true, drawMeasureNumbersOnlyAtSystemStart: true, disableCursor: true });
      applyMeasureGrid(osmd);
      await osmd.load(grid.xml);
      osmd.Zoom = entry.zoom;
      renderMeasureGrid(osmd, host, MusicSystemBuilder);
      const measures = osmd.GraphicSheet.MeasureList;
      const systems = [...new Set(measures.map(([measure]) => measure.ParentMusicSystem))];
      let cellWidth: number | null = null;
      for (const system of systems) for (const line of system.StaffLines) {
        assert(line.Measures.length === 4, '每行应有四个小节位置');
        line.Measures.forEach((measure, column) => {
          cellWidth ??= measure.PositionAndShape.Size.width;
          assert(Math.abs(measure.PositionAndShape.Size.width - cellWidth) < .001, '小节宽度必须一致');
          assert(Math.abs(measure.PositionAndShape.RelativePosition.x - column * cellWidth) < .001, '上下行边界必须对齐');
        });
      }
      const adapter = new OsmdScoreViewAdapter(osmd);
      const mapping = adapter.buildMapping(original);
      assert(mapping.anchorStatus === 'COMPLETE' && mapping.conflicts.length === 0, '原有音符必须完整映射');
      assert(mapping.mappedEventCount === mapping.noteEventCount, '空位不能影响真实音符定位');
      const first = original.parts[0].measures.flatMap((measure) => measure.events).find((event) => event.kind === 'note')!;
      assert(adapter.highlightScoreEvent(first.id, 'current'), '首音仍可高亮');
      assert(prototype.stretchMusicSystem === nativeStretch && prototype.checkAndCreateExtraInstructionMeasure === nativeCourtesy, '原生排版方法必须恢复');
      assert(original.parts[0].measures.length === grid.measureCount, '评分文档不能追加空小节');
      const row = document.createElement('li');
      row.textContent = `通过 · ${entry.name} · ${systems.length} 行 · ${mapping.mappedEventCount} 个音符完整定位`;
      results.append(row);
      if (entry.name === '5 小节 / 1200px') {
        adapter.clearHighlights();
        const notes = original.parts[0].measures.flatMap((measure) => measure.events).filter((event) => event.kind === 'note');
        const next = notes.find((note) => note.source.measureOrdinal === 1 && note.onsetBeat.numerator !== first.onsetBeat.numerator)!;
        const future = notes.find((note) => note.source.measureOrdinal === 5)!;
        // Replay the display bug: the user is in measure one while the
        // independent rhythm clock has a hit in measure five.
        const timingIds = timelineHitNoteIds({ grade: 'good', targetIndex: 1 }, [[first.id], [future.id]], true);
        for (const id of timingIds) adapter.highlightScoreEvent(id, 'user');
        adapter.highlightScoreEvent(first.id, 'user');
        adapter.highlightScoreEvent(next.id, 'current');
        const colors = (id: string) => adapter.getGraphicalNotes(id).flatMap((note) => {
          const heads = (note as unknown as { getNoteheadSVGs(): HTMLElement[] }).getNoteheadSVGs();
          return heads.flatMap((head) => [head, ...head.querySelectorAll('[fill]')])
            .map((node) => node.getAttribute('fill')).filter(Boolean);
        });
        assert(colors(first.id).includes('#1d9b72'), '弹对音符应为绿色');
        assert(colors(next.id).includes('#2f6fdb'), '当前目标应为蓝色');
        assert(colors(future.id).includes('#20252d'), '未弹到的第五小节必须保持黑色');
        const isolation = document.createElement('p');
        isolation.textContent = '高亮隔离通过：第一小节已弹为绿色、当前目标为蓝色；第五小节保持黑色。';
        isolation.dataset.highlightIsolation = 'pass';
        preview.before(isolation);
        wrapper.className = '';
        preview.append(wrapper);
      } else if (entry.xml === triads) {
        adapter.clearHighlights();
        const notes = original.parts[0].measures[0].events.filter((event) => event.kind === 'note');
        const group = notes.slice(0, 3).map((event) => event.id);
        const feedback = group.map((scoreEventId) => ({ scoreEventId, state: 'hit' as const }));
        const fills = (id: string) => adapter.getGraphicalNotes(id).flatMap((note) =>
          (note as unknown as { getNoteheadSVGs(): HTMLElement[] }).getNoteheadSVGs().flatMap((head) =>
            [head, ...head.querySelectorAll('[fill]')].map((node) => node.getAttribute('fill'))));
        for (const [id, color] of fixedLineGroupHighlights([group], feedback, -1)) adapter.highlightScoreEvent(id, color);
        assert(group.every((id) => fills(id).includes('#1d9b72')), '三个正确音齐全且无多余音时应为绿色');
        for (const [id, color] of fixedLineGroupHighlights([group], feedback.map((item) => ({ ...item, extraCount: 1 })), -1)) adapter.highlightScoreEvent(id, color);
        assert(group.every((id) => fills(id).includes('#c34b58') && !fills(id).includes('#1d9b72')), '多按一个错音后整组应为红色');
        assert(fills(notes[3].id).includes('#20252d'), '下一组未弹的和弦应保持黑色');
        const caption = document.createElement('p');
        caption.textContent = '和弦反馈通过：C–E–G 全部命中但多按 F♯，整组红色；下一组保持黑色。';
        caption.dataset.chordExtra = 'pass';
        preview.append(caption);
        wrapper.className = '';
        preview.append(wrapper);
      } else wrapper.remove();
      passed += 1;
    } catch (error) {
      wrapper.remove();
      throw new Error(`${entry.name}：${String(error)}`);
    }
  }
  status.textContent = `${passed} 组检查通过：每行四列、空白补位、上下对齐，真实音符定位保持完整。`;
  status.dataset.contractResult = 'pass';
}
void run().catch((error) => {
  status.textContent = String(error);
  status.dataset.contractResult = 'fail';
});
