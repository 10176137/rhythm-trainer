/** Browser contract for the pinned OSMD 2.2.1 grid adapter. No engine/session. */
import { OpenSheetMusicDisplay, MusicSystemBuilder } from 'opensheetmusicdisplay';
import { applyMeasureGrid, prepareMeasureGrid, renderMeasureGrid } from '../../components/osmdEngraving';
import { importScoreText } from '../../features/score/scoreImport';
import { createSkillDrill } from '../../features/practice/skillDrills';
import { OsmdScoreViewAdapter } from '../view/score-view-adapter';
import sample from '../../features/score/fixtures/c-major-practice.musicxml?raw';

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
  { name: '双手密集音阶 / F 大调', xml: createSkillDrill('scales', 3, 60, { key: 'F', hand: 'both' }).xml, width: 760, zoom: 1.3 },
  { name: '单独低音谱表 / G 大调', xml: createSkillDrill('five-finger', 2, 60, { key: 'G', hand: 'left' }).xml, width: 860, zoom: 1 },
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
        adapter.highlightScoreEvent(first.id, 'default');
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
