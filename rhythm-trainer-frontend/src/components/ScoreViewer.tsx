import { useEffect, useMemo, useRef, useState } from 'react';
import OsmdScoreView, { ENGRAVED_SCORE_WIDTH } from './OsmdScoreView';
import type { ScoreMeta, ScoreNote } from '../core/sampleScore';
import { countdownWholeSeconds } from '../features/practice/countdown';
import type { HandSelection } from '../types/practice';
import type { ScoreDocument as EngineScoreDocument } from '../score-engine/domain/types';

interface Props {
  focus?: boolean;
  /** Fit every engraved system to the pane width (no horizontal scrolling). */
  fitToWidth?: boolean;
  score: ScoreNote[];
  meta: ScoreMeta;
  warnings?: string[];
  tempo: number;
  strictAssessment: boolean;
  /** Note ids in the engine's current target group (chords share one target). */
  activeNoteIds: string[];
  hand: HandSelection;
  /** Notes currently in scope (hand/loop filtered by the workspace). */
  notes?: ScoreNote[];
  /** The committed boundary notes; band edges clip to their exact positions. */
  loopRangeNotes?: { start: { eventId: string }; end: { eventId: string } } | null;
  loopEnabled?: boolean;
  /** Commits a dragged loop boundary (A=start, B=end) snapped to a note. */
  onLoopDragCommit?: (which: 'start' | 'end', eventId: string) => void;
  /** Taps on the score adjust the loop range (no on-screen instruction). */
  loopPickArmed?: boolean;
  onLoopPick?: (eventId: string) => void;
  onSelectNote?: (eventId: string) => void;
  onInteractionStart?: () => void;
  showNoteNames: boolean;
  showPositionHints: boolean;
  /** Last MIDI note-on/off received from the device or virtual keyboard. */
  lastInputMidi: number | null;
  /** Original MusicXML and semantic document for the professional engraver. */
  sourceXml?: string;
  engine?: EngineScoreDocument;
  /** Incremented only after the player hits the current target correctly. */
  followPulse?: number;
  /** Target note IDs the system has played (red in the professional score). */
  systemNoteIds?: string[];
  /** Target note IDs the player has hit correctly (green). */
  userNoteIds?: string[];
  /** System duet: the system plays the correct notes as an audible guide. */
  systemDuet?: boolean;
  onToggleSystemDuet?: () => void;
  /** System music sound (red visual part can continue silently when muted). */
  systemAudio?: boolean;
  onToggleSystemAudio?: () => void;
  /** Pre-engine preparation countdown for follow/free practice. */
  prepRemain?: number | null;
  /** Backend-scheduled ms until the first note; zero/negative hides the overlay. */
  firstNoteCountdownMs?: number | null;
}



export default function ScoreViewer({
  focus = false,
  fitToWidth = false,
  score,
  meta,
  warnings = [],
  activeNoteIds,
  hand,
  loopRangeNotes = null,
  loopEnabled = false,
  onLoopDragCommit,
  loopPickArmed = false,
  onLoopPick,
  onSelectNote,
  onInteractionStart,
  sourceXml,
  engine,
  followPulse = 0,
  systemNoteIds = [],
  userNoteIds = [],
  systemDuet = false,
  onToggleSystemDuet,
  systemAudio = true,
  onToggleSystemAudio,
  prepRemain = null,
  firstNoteCountdownMs = null,
}: Props) {
  const firstNoteCountdownSeconds = countdownWholeSeconds(firstNoteCountdownMs);
  const mutedNoteIds = useMemo(
    () => loopEnabled || loopRangeNotes || loopPickArmed ? [] : score.filter((note) => hand !== 'both' && note.hand !== hand).map((note) => note.id),
    [score, hand, loopEnabled, loopRangeNotes, loopPickArmed],
  );
  const [manualAtPulse, setManualAtPulse] = useState<number | null>(null);
  const browsing = manualAtPulse !== null && manualAtPulse === followPulse;
  const [followRequest, setFollowRequest] = useState(0);
  const [osmdRevision, setOsmdRevision] = useState(0);
  const [horizontalScroll, setHorizontalScroll] = useState({ max: 0, value: 0 });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canEngrave = Boolean(sourceXml && engine);
  const activeBar = useMemo(() => {
    const bars = activeNoteIds
      .map((id) => score.find((note) => note.id === id)?.bar)
      .filter((bar): bar is number => typeof bar === 'number');
    return bars.length ? Math.min(...bars) : null;
  }, [activeNoteIds, score]);

  useEffect(() => {
    setManualAtPulse(null);
    setFollowRequest((value) => value + 1);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
      scrollRef.current.scrollLeft = 0;
    }
  }, [score, meta.barCount]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const update = () => setHorizontalScroll({
      max: Math.max(0, container.scrollWidth - container.clientWidth),
      value: container.scrollLeft,
    });
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(container);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [osmdRevision, canEngrave]);

  const resumeFollow = () => {
    setManualAtPulse(null);
    setFollowRequest((value) => value + 1);
  };
  const browseScore = () => setManualAtPulse(followPulse);

  return (
    <div className="score-wrap">
      {warnings.length > 0 && (
        <div className="score-warning score-warning-info" role="status">
          <strong>导入提示</strong>
          <ul>
            {warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      )}

      {canEngrave ? (
        <>
          <div className="score-system-toolbar"><div className="score-system-toolbar-pill">
            <span className="score-system-count">专业谱面 · OSMD / Bravura</span>
            <span className="score-system-current">第 {activeBar ?? 1} 小节</span>
            <button
              type="button"
              className={`score-window-follow${browsing ? '' : ' on'}`}
              aria-pressed={!browsing}
              onClick={resumeFollow}
              title="手动翻谱后停留浏览；点击回到当前，或弹对当前目标后恢复跟随"
            >
              <i />{browsing ? '回到当前' : '跟随中'}
            </button>
            <button
              type="button"
              className={`score-correct-toggle${systemDuet ? ' on' : ''}`}
              aria-pressed={systemDuet}
              onClick={() => onToggleSystemDuet?.()}
              title="系统按引擎目标自己弹奏；系统弹过的音符标红"
            >
              <i />系统伴弹 {systemDuet ? '开' : '关'}
            </button>
            <button
              type="button"
              className={`score-audio-toggle${systemAudio ? ' on' : ''}`}
              aria-pressed={systemAudio}
              onClick={() => onToggleSystemAudio?.()}
              title="开/关系统演奏的声音；关闭后红色系统声部仍按时间推进"
            >
              <i />{systemAudio ? '有声' : '静音'}
            </button>
            </div>
          </div>

          {horizontalScroll.max > 1 && (
            <div className="score-hscroll">
              <span className="score-hscroll-hint">谱面固定宽度</span>
              <input
                type="range"
                className="score-hscroll-range"
                min={0}
                max={horizontalScroll.max}
                step={1}
                value={Math.min(horizontalScroll.value, horizontalScroll.max)}
                aria-label="谱面水平位置"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (scrollRef.current) scrollRef.current.scrollLeft = next;
                  setHorizontalScroll((prev) => ({ ...prev, value: next }));
                }}
              />
              <span className="score-hscroll-hint">左右滑动 / 放大窗口可完整显示</span>
            </div>
          )}

          <div
            className="score-canvas score-systems"
            ref={scrollRef}
            role="region"
            aria-label="可滚动乐谱"
            tabIndex={0}
            onWheel={browseScore}
            onTouchStart={browseScore}
            onPointerDown={browseScore}
            onKeyDown={(event) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) browseScore(); }}
            onScroll={(event) => {
              const container = event.currentTarget;
              setHorizontalScroll((prev) => (
                prev.value === container.scrollLeft ? prev : { ...prev, value: container.scrollLeft }
              ));
            }}
          >
            {browsing && <div className="score-follow-return">
              <button type="button" className="button button-outline button-small" onPointerDown={(event) => event.stopPropagation()} onClick={resumeFollow}>回到当前</button>
            </div>}
            {prepRemain !== null ? (
              <div className="prep-overlay" role="status" aria-live="assertive">
                <strong>{prepRemain}</strong>
                <span>准备开始</span>
                <small>3 秒后才开始计时，可以先调整手位</small>
              </div>
            ) : firstNoteCountdownSeconds !== null && (
              <div className="prep-overlay" role="status" aria-live="assertive">
                <strong>{firstNoteCountdownSeconds}</strong>
                <span>距离第一个音</span>
                <small>按后端排定的首音时刻倒数，数字归零就是第一个音</small>
              </div>
            )}
            <OsmdScoreView
              width={ENGRAVED_SCORE_WIDTH}
              fitWidth={focus || fitToWidth}
              xml={sourceXml!}
              engine={engine!}
              activeNoteIds={activeNoteIds}
              follow={!browsing}
              followSignal={followPulse + followRequest}
              systemNoteIds={systemNoteIds}
              userNoteIds={userNoteIds}
              mutedNoteIds={mutedNoteIds}
              loopRangeNotes={loopRangeNotes}
              onLoopDragCommit={onLoopDragCommit}
              onInteractionStart={onInteractionStart}
              colorSystemNotes={systemDuet}
              scrollRef={scrollRef}
              onSelectEvent={(eventId) => { if (onSelectNote) onSelectNote(eventId); else if (loopPickArmed && onLoopPick) onLoopPick(eventId); }}
              onRendered={() => setOsmdRevision((value) => value + 1)}
            />
          </div>
        </>
      ) : (
        <section className="card error-strip">
          <strong>无法渲染专业谱面</strong>
          <p>当前谱面没有原始 MusicXML；请从乐谱库重新载入或导入 MusicXML。</p>
        </section>
      )}
    </div>
  );
}
