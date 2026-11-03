import type { ReactNode } from 'react';
import type { HandSelection, PracticeConfig, ScoreAdvanceMode } from '../types/practice';

interface Props {
  config: PracticeConfig;
  barCount: number;
  locked: boolean;
  busy: boolean;
  supportsHandSelection: boolean;
  systemDuet: boolean;
  metronomeOn: boolean;
  midiConnected: boolean;
  deviceLabel: string;
  onReturn: () => void;
  onChooseScore: () => void;
  onDevices: () => void;
  onToggleMode: () => void;
  onPatch: (patch: Partial<PracticeConfig>) => void;
  onToggleMetronome: () => void;
  children: ReactNode;
  playbackControls?: ReactNode;
}
/** Presentation and input controls only. The session and config have one
 * owner above this toolbar; no cached draft or alternative scoring state. */
export default function PerformanceToolbar(props: Props) {
  const { config, locked, onPatch } = props;
  const fixedLine = config.modeId === 'fixed-line';
  return <div className="performance-toolbar">
    <button type="button" className="pt-btn ghost" title="退出全屏演奏" onClick={props.onReturn}>← 返回</button>
    <div className="pt-group">
      <button type="button" className="pt-btn" onClick={props.onChooseScore}><span className="pt-glyph">♪</span>选曲</button>
      <button type="button" className="pt-btn" disabled={props.busy || locked} onClick={props.onToggleMode}>
        <span className="pt-glyph">{fixedLine ? '▤' : '♫'}</span>{fixedLine ? '固定线' : '读谱'}
      </button>
      <button type="button" className={`pt-btn pt-midi ${props.midiConnected ? 'on' : ''}`} onClick={props.onDevices} title={props.deviceLabel}><i />MIDI</button>
    </div>
    <span className="pt-divider" />
    <div className="pt-group">
      <div className="pt-stepper" title="练习速度（BPM）">
        <button type="button" aria-label="减速" disabled={locked} onClick={() => onPatch({ tempo: Math.max(40, config.tempo - 4) })}>−</button>
        <b>{config.tempo}</b>
        <button type="button" aria-label="加速" disabled={locked} onClick={() => onPatch({ tempo: Math.min(160, config.tempo + 4) })}>＋</button>
      </div>
      <select className="pt-select" aria-label="练习手" value={config.hand} disabled={locked || !props.supportsHandSelection} onChange={(e) => onPatch({ hand: e.target.value as HandSelection })}>
        <option value="both">双手</option><option value="right">右手</option><option value="left">左手</option>
      </select>
      {config.modeId === 'score' && <button type="button" className={`pt-btn ${config.loopEnabled ? 'on' : ''}`} aria-pressed={config.loopEnabled} disabled={locked}
        title={config.loopSelectionPending ? '点击谱面选择新的循环起点和终点' : '关闭后清除选区；再次开启可重新选择'}
        onClick={() => onPatch({ loopEnabled: !config.loopEnabled, loopSelectionPending: !config.loopEnabled,
          loopStartNote: null, loopEndNote: null, playbackStartNote: null, loopStartBar: 1, loopEndBar: Math.max(1, props.barCount) })}>{config.loopEnabled ? config.loopSelectionPending ? '选择循环范围' : '循环中' : '循环'}</button>}
      <button type="button" className={`pt-btn ${props.metronomeOn ? 'on' : ''}`} aria-pressed={props.metronomeOn}
        title={`节拍器跟随练习速度（${config.tempo} BPM）`} disabled={props.busy} onClick={props.onToggleMetronome}>{props.metronomeOn ? '节拍器开' : '节拍器'}</button>
      <select className="pt-select" aria-label="练习推进" value={props.systemDuet ? 'timeline' : config.advanceMode}
        disabled={locked || props.systemDuet || fixedLine} onChange={(e) => onPatch({ advanceMode: e.target.value as ScoreAdvanceMode })}>
        <option value="follow">跟手</option><option value="timeline">固定时间</option>
      </select>
    </div>
    <span className="pt-toolbar-spacer" />
    {props.playbackControls}
    {props.children}
  </div>;
}
