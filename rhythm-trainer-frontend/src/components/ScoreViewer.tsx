import { useEffect, useMemo, useRef, useState } from 'react';
import KeyboardReference from './KeyboardReference';
import OsmdScoreView from './OsmdScoreView';
import type { ScoreMeta, ScoreNote } from '../core/sampleScore';
import { getStaffPlacement, midiToPitchName } from '../features/score/staffMapping';
import { beatPositionLabel, durationLabel } from '../features/score/scoreLayout';
import { playPreviewTone } from '../features/score/previewTone';
import { countdownWholeSeconds } from '../features/practice/countdown';
import type { HandSelection, PracticeModeId } from '../types/practice';
import type { ScoreDocument as EngineScoreDocument } from '../score-engine/domain/types';

interface Props {
  score: ScoreNote[];
  meta: ScoreMeta;
  warnings?: string[];
  tempo: number;
  strictAssessment: boolean;
  /** Note ids in the engine's current target group (chords share one target). */
  activeNoteIds: string[];
  hand: HandSelection;
  modeId: PracticeModeId;
  /** Notes currently in scope (hand/loop filtered by the workspace). */
  notes?: ScoreNote[];
  /** Loop range; measures outside it get a translucent green cover. */
  loopStartBar?: number;
  loopEndBar?: number;
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
  /** Target note IDs the player has hit correctly (blue). */
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

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z" fill="currentColor" />
      <path d="M15.2 8.2c1.3 1.5 1.3 6.1 0 7.6M17.8 5.6c2.7 2.9 2.7 9.9 0 12.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function ScoreViewer({
  score,
  meta,
  warnings = [],
  tempo,
  strictAssessment,
  activeNoteIds,
  hand,
  modeId,
  notes,
  loopStartBar,
  loopEndBar,
  showNoteNames,
  showPositionHints,
  lastInputMidi,
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
  const scopedNotes = notes ?? score.filter((note) => hand === 'both' || note.hand === hand);
  const scopedIds = useMemo(() => new Set(scopedNotes.map((note) => note.id)), [scopedNotes]);
  const mutedNoteIds = useMemo(
    () => score.filter((note) => !scopedIds.has(note.id)).map((note) => note.id),
    [score, scopedIds],
  );
  const loopCoveredMeasures = useMemo(() => {
    if (modeId !== 'loop' || !Number.isInteger(loopStartBar) || !Number.isInteger(loopEndBar)) return [];
    const maxMeasure = Math.max(meta.barCount, ...score.map((note) => note.bar));
    return Array.from({ length: maxMeasure }, (_, index) => index + 1)
      .filter((measure) => measure < loopStartBar! || measure > loopEndBar!);
  }, [modeId, loopStartBar, loopEndBar, meta.barCount, score]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [followRequest, setFollowRequest] = useState(0);
  const [osmdRevision, setOsmdRevision] = useState(0);
  const [horizontalScroll, setHorizontalScroll] = useState({ max: 0, value: 0 });
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const canEngrave = Boolean(sourceXml && engine);
  const selectedNote = pickedId ? score.find((note) => note.id === pickedId) ?? null : null;
  const selectedPlacement = selectedNote
    ? getStaffPlacement(selectedNote.staff, selectedNote.step, selectedNote.alter, selectedNote.octave)
    : null;
  const selectedInScope = selectedNote ? scopedIds.has(selectedNote.id) : false;
  const midiMatched = selectedNote !== null && lastInputMidi !== null && selectedNote.midiNote === lastInputMidi;
  const lastInputName = lastInputMidi !== null ? midiToPitchName(lastInputMidi) : null;
  const previewNote = score.find((note) => activeNoteIds.includes(note.id)) ?? selectedNote ?? score[0];
  const previewMidi = previewNote?.midiNote ?? null;
  const activeBar = useMemo(() => {
    const bars = activeNoteIds
      .map((id) => score.find((note) => note.id === id)?.bar)
      .filter((bar): bar is number => typeof bar === 'number');
    return bars.length ? Math.min(...bars) : null;
  }, [activeNoteIds, score]);
  const handLabel = hand === 'both' ? '双手钢琴' : hand === 'right' ? '右手' : '左手';
  const rightCount = score.filter((note) => note.hand === 'right').length;
  const leftCount = score.filter((note) => note.hand === 'left').length;

  useEffect(() => {
    setPickedId(null);
    setFollow(true);
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

  const toggleFollow = () => {
    if (follow) {
      setFollow(false);
      return;
    }
    setFollow(true);
    setFollowRequest((value) => value + 1);
  };

  return (
    <div className="score-wrap">
      <header className="score-header">
        <div className="score-heading">
          <div className="score-kicker">
            {meta.integration === 'fixture' ? '原创示例 · 大谱表' : '导入乐谱 · MusicXML'}
          </div>
          <h2>{meta.title}{modeId === 'loop' ? '（循环段落）' : ''}</h2>
          <p className="score-subtitle">{meta.composer} · {meta.staves === 1 ? '单谱表' : '双谱表'} · {meta.barCount} 小节</p>
          <div className="score-bpm"><span>♩</span> = {tempo} BPM</div>
        </div>
        <div className="score-header-side">
          <div className="score-tags">
            <span>{meta.timeSignature[0]}/{meta.timeSignature[1]} 拍</span>
            <span>{meta.keySignature}</span>
            <span>{handLabel}</span>
          </div>
          <button
            type="button"
            className="score-preview"
            onClick={() => previewMidi !== null && playPreviewTone(previewMidi)}
            disabled={previewMidi === null}
            title="试听当前音"
            aria-label="试听当前音"
          >
            <SpeakerIcon />
          </button>
        </div>
      </header>

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
          <div className="score-system-toolbar">
            <span className="score-system-count">专业谱面 · OSMD / Bravura</span>
            <span className="score-system-current">当前第 {activeBar ?? 1} 小节</span>
            <button
              type="button"
              className={`score-window-follow${follow ? ' on' : ''}`}
              aria-pressed={follow}
              onClick={toggleFollow}
              title="只在弹对当前目标后跟随；手动滚动不会被拉回"
            >
              <i />{follow ? '弹对后跟随' : '跟随'}
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
              <i />系统音乐 {systemAudio ? '开' : '关'}
            </button>
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
            onScroll={(event) => {
              const container = event.currentTarget;
              setHorizontalScroll((prev) => (
                prev.value === container.scrollLeft ? prev : { ...prev, value: container.scrollLeft }
              ));
            }}
          >
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
              xml={sourceXml!}
              engine={engine!}
              activeNoteIds={activeNoteIds}
              follow={follow}
              followSignal={followPulse + followRequest}
              systemNoteIds={systemNoteIds}
              userNoteIds={userNoteIds}
              mutedNoteIds={mutedNoteIds}
              loopCoveredMeasures={loopCoveredMeasures}
              colorSystemNotes={systemDuet}
              scrollRef={scrollRef}
              onSelectEvent={(eventId) => setPickedId(eventId)}
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

      {selectedNote && selectedPlacement && (!strictAssessment || showNoteNames) && (
        <section className={`note-inspector${midiMatched ? ' is-midi-matched' : ''}`} aria-live="polite">
          <div className="note-inspector-main">
            <div className="note-inspector-head">
              <span className={`note-token${showPositionHints ? (selectedPlacement.line ? ' token-line' : ' token-space') : ''}`}>
                {selectedNote.noteName}
              </span>
              <div>
                <strong>{selectedNote.noteName} · 第 {selectedNote.octave} 八度</strong>
                <p>{selectedPlacement.staffLabel} · {selectedNote.hand === 'right' ? '右手' : '左手'} · {beatPositionLabel(selectedNote, meta.beatsPerBar, meta.measures)}</p>
              </div>
              {midiMatched ? (
                <span className="midi-match-badge">MIDI 匹配</span>
              ) : lastInputName ? (
                <span className="note-input-status">最近输入 {lastInputName}</span>
              ) : (
                <span className="note-input-status">点击音符查看</span>
              )}
              {!selectedInScope && <span className="note-scope-status">当前未纳入练习</span>}
            </div>
            <dl className="note-facts">
              <div><dt>音名</dt><dd>{selectedNote.noteName}</dd></div>
              <div><dt>音区</dt><dd>第 {selectedNote.octave} 八度</dd></div>
              <div><dt>谱表</dt><dd>{selectedPlacement.staffLabel}</dd></div>
              <div><dt>线/间</dt><dd>{selectedPlacement.positionLabel} · {selectedPlacement.positionDetail}</dd></div>
              <div><dt>虚拟键盘键位</dt><dd>{selectedNote.noteName} · MIDI {selectedNote.midiNote}</dd></div>
              <div><dt>时值</dt><dd>{durationLabel(selectedNote)} · {selectedNote.durationBeats} 拍</dd></div>
            </dl>
          </div>
          <KeyboardReference midiNote={selectedNote.midiNote} />
        </section>
      )}

      {selectedNote && selectedPlacement && strictAssessment && !showNoteNames && (
        <section className="note-inspector note-inspector-locked" aria-live="polite">
          <div className="note-inspector-head">
            <span className="note-token note-token-locked" aria-hidden="true">?</span>
            <div>
              <strong>音名提示已关闭</strong>
              <p>严格测验中不显示音名、音区、谱表与键位详情，避免泄露答案。可在线/间提示中查看位置。</p>
            </div>
            <span className="note-input-status">
              已选音符{showPositionHints ? ` · ${selectedPlacement.positionLabel}` : ''}
            </span>
          </div>
        </section>
      )}

      <section className="score-tips">
        <h3>阅读提示</h3>
        {hand !== 'both' && (
          <p>当前只练{handLabel}：另一只手的音符已淡化，仅作为谱面上下文，不是本轮目标。</p>
        )}
        {meta.staves === 1 ? (
          <p>单谱表：按谱面音高逐音识别；五线之外的音符使用加线表示，注意加线数量与线/间位置。</p>
        ) : (
          <>
            <p>上方高音谱表通常对应右手；下方低音谱表通常对应左手。本谱共 {score.length} 个音符，右手 {rightCount} 个、左手 {leftCount} 个。</p>
            <p>练习结构：每小节按 MusicXML 拍号显示；左右手同时出现的音对齐在同一拍。谱面由 OSMD / Bravura 专业制谱引擎渲染。</p>
          </>
        )}
      </section>

      <div className="score-display-note">
        <i />
        <span>当前目标会在专业谱面上高亮；只有弹对当前目标后才会自动跟随滚动，手动往下查看不会被拉回。</span>
      </div>
      <p className="score-source-line">
        {meta.integration === 'fixture' ? meta.integrationNote : `导入：${meta.sourceFile.split(/[\\/]/).pop()}。${meta.integrationNote}`}
      </p>
    </div>
  );
}
