/** Real focus components, read-only score fixtures, no engine/session/MIDI. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AppShell from '../../components/AppShell';
import ScoreViewer from '../../components/ScoreViewer';
import { importScoreText } from '../../features/score/scoreImport';
import dense from './fixtures/grid-dense-scale.musicxml?raw';
import ordinary from '../../features/score/fixtures/c-major-practice.musicxml?raw';
import octave from '../../features/score/fixtures/octave-shifts.musicxml?raw';
import '../../styles.css';

const sourceBars = [...ordinary.matchAll(/<measure\b[\s\S]*?<\/measure>/g)].map((match) => match[0]);
const longScore = ordinary.replace(/<measure\b[\s\S]*<\/measure>/, Array.from({ length: 32 }, (_, index) =>
  sourceBars[index === 0 ? 0 : 1 + (index - 1) % 3].replace(/number="\d+"/, `number="${index + 1}"`)).join(''));
const fixtures = [dense, ordinary, octave, longScore];

function FocusScoreContract() {
  const [choice, setChoice] = useState(0);
  const [focus, setFocus] = useState(true);
  const [activeBar, setActiveBar] = useState(1);
  const [pulse, setPulse] = useState(0);
  const statusRef = useRef<HTMLSpanElement>(null);
  const doc = useMemo(() => importScoreText(fixtures[choice], 'focus-contract.musicxml').doc!, [choice]);
  const engineBefore = useMemo(() => JSON.stringify(doc.engine), [doc]);

  useEffect(() => {
    let frame = 0;
    const inspect = () => {
      const pane = document.querySelector<HTMLElement>('.score-systems');
      const host = pane?.querySelector<HTMLElement>('.osmd-host');
      const svg = host?.querySelector('svg');
      const status = statusRef.current;
      if (!pane || !host || !svg || !status || host.dataset.osmdStage !== 'done') return;
      const padding = getComputedStyle(pane);
      const paneBox = pane.getBoundingClientRect();
      const box = svg.getBoundingClientRect();
      const left = paneBox.left + parseFloat(padding.paddingLeft);
      const right = paneBox.left + pane.clientWidth - parseFloat(padding.paddingRight);
      const inBounds = box.left >= left - 1 && box.right <= right + 1;
      const noHorizontalScroll = pane.scrollWidth <= pane.clientWidth + 1;
      const complete = host.dataset.osmdMapped === host.dataset.osmdTotal && host.dataset.osmdAnchorStatus === 'COMPLETE';
      const unchanged = JSON.stringify(doc.engine) === engineBefore;
      const fourColumns = [...svg.querySelectorAll('g.staffline')]
        .every((line) => line.querySelectorAll(':scope > g.vf-measure').length === 4);
      const ok = inBounds && noHorizontalScroll && complete && unchanged && fourColumns;
      status.dataset.contractResult = ok ? 'pass' : 'fail';
      status.dataset.fitMetrics = JSON.stringify({
        viewport: [innerWidth, innerHeight], left: box.left, right: box.right,
        availableLeft: left, availableRight: right, scrollWidth: pane.scrollWidth,
        clientWidth: pane.clientWidth, naturalWidth: Number(svg.getAttribute('width')),
        mapped: host.dataset.osmdMapped, total: host.dataset.osmdTotal,
        fourColumns,
      });
      status.textContent = ok ? '适配通过 · 左右完整 · 音符定位完整' : '适配检查失败';
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(inspect); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.getElementById('root')!, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-osmd-stage'] });
    const resize = new ResizeObserver(schedule);
    const pane = document.querySelector('.score-systems');
    if (pane) resize.observe(pane);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [doc, engineBefore]);

  return <AppShell focus={focus} sidebar={null} topbar={null}>
    <div className="page-content app-workspace">
      <div className="workspace-grid">
        <section className="card score-card">
          <section className="session-strip">
            <div className="session-controls">
              <span id="focus-contract-status" ref={statusRef} className="focus-session-label">专注模式适配验证…</span>
              <button className="button button-outline" onClick={() => setFocus((current) => !current)}>{focus ? '切换普通视图' : '进入专注'}</button>
              <select aria-label="验证谱例" value={choice} onChange={(event) => setChoice(Number(event.target.value))}>
                <option value={0}>密集音阶</option><option value={1}>普通双手</option><option value={2}>高低八度</option><option value={3}>长谱跟随</option>
              </select>
              {choice === 3 && <>
                {[5, 9, 29].map((bar) => <button key={bar} onClick={() => { setActiveBar(bar); setPulse((value) => value + 1); }}>模拟弹对到第{bar}小节</button>)}
                <button onClick={() => setActiveBar(9)}>只推进时钟到第9小节</button>
                <span data-follow-progress={activeBar}>显示目标：第 {activeBar} 小节 · 只验证显示，不评分</span>
              </>}
            </div>
          </section>
          <ScoreViewer focus={focus} score={doc.notes} meta={doc.meta} warnings={[]} tempo={60}
            strictAssessment={false} activeNoteIds={choice === 3 ? doc.notes.filter((note) => note.bar === activeBar).slice(0, 1).map((note) => note.id) : doc.notes.slice(1, 2).map((note) => note.id)}
            followPulse={pulse}
            userNoteIds={doc.notes.slice(0, 1).map((note) => note.id)} hand="both" modeId="score"
            showNoteNames={false} showPositionHints={false} lastInputMidi={null}
            sourceXml={doc.sourceXml} engine={doc.engine} />
        </section>
      </div>
    </div>
  </AppShell>;
}

createRoot(document.getElementById('root')!).render(<FocusScoreContract />);
