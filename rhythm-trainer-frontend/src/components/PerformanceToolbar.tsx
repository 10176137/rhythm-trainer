import { PracticeChromeContext } from '../features/practice/usePracticeChrome';
import { ArrowLeftOutlined as ArrowLeftIcon, DownOutlined as ChevronDownIcon, SettingOutlined as GearIcon, RetweetOutlined as LoopIcon, FieldTimeOutlined as TimerIcon } from '@ant-design/icons';
import { AppButton, ChoiceSelect } from './ui/controls';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import SettingsDialog from './SettingsDialog';
import './performanceToolbar.css';
import type { HandSelection, PracticeConfig, ScoreAdvanceMode } from '../types/practice';

interface Props {
  title?: string;
  performing?: boolean;
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => { if (props.performing) setSettingsOpen(false); }, [props.performing]);
  const visible = useContext(PracticeChromeContext);
  const fixedLine = config.modeId === 'fixed-line';
  return <div className={`performance-toolbar${props.performing ? ' is-performing' : ''}`}>
    <div className="performance-toolbar-panel" data-practice-chrome inert={!visible} aria-hidden={!visible}>
    <AppButton type="button" className="pt-btn ghost toolbar-back" title="退出全屏演奏" onClick={props.onReturn}><ArrowLeftIcon aria-hidden />返回</AppButton>
    <AppButton type="button" className="performance-score-title" onClick={props.onChooseScore} title="选择乐谱"><span className="performance-score-name">{props.title || '选择乐谱'}</span><ChevronDownIcon aria-hidden /></AppButton>

    <div className="performance-quick-settings" role="group" aria-label="常用练习设置">
      <div className="pt-stepper" title="练习速度（BPM）">
        <AppButton type="button" aria-label="减速" disabled={locked} onClick={() => onPatch({ tempo: Math.max(40, config.tempo - 4) })}>−</AppButton>
        <b>{config.tempo}<small> BPM</small></b>
        <AppButton type="button" aria-label="加速" disabled={locked} onClick={() => onPatch({ tempo: Math.min(160, config.tempo + 4) })}>＋</AppButton>
      </div>
      <ChoiceSelect label="练习手" value={config.hand} disabled={locked || !props.supportsHandSelection}
        onValueChange={value => onPatch({ hand: value as HandSelection })}
        options={[{ value: 'both', label: '双手' }, { value: 'right', label: '右手' }, { value: 'left', label: '左手' }]} />
      <AppButton type="button" className={`pt-btn ${props.metronomeOn ? 'on' : ''}`} aria-pressed={props.metronomeOn}
        title={`节拍器跟随练习速度（${config.tempo} BPM）`} disabled={props.busy} onClick={props.onToggleMetronome}><TimerIcon aria-hidden />{props.metronomeOn ? '节拍器开' : '节拍器'}</AppButton>
      {config.modeId === 'score' && <AppButton type="button" className={`pt-btn ${config.loopEnabled ? 'on' : ''}`} aria-pressed={config.loopEnabled} disabled={locked}
        title={config.loopSelectionPending ? '点击谱面选择新的循环起点和终点' : '关闭后清除选区；再次开启可重新选择'}
        onClick={() => onPatch({ loopEnabled: !config.loopEnabled, loopSelectionPending: !config.loopEnabled,
          loopStartNote: null, loopEndNote: null, playbackStartNote: null, loopStartBar: 1, loopEndBar: Math.max(1, props.barCount) })}><LoopIcon aria-hidden />{config.loopEnabled ? config.loopSelectionPending ? '选择循环范围' : '循环中' : '循环'}</AppButton>}
    {props.playbackControls}
    </div>
    <span className="pt-toolbar-spacer" />
    <AppButton type="button" className="pt-btn ghost toolbar-settings" aria-label="更多设置" disabled={props.performing} onClick={() => setSettingsOpen(true)}><GearIcon aria-hidden /><span className="toolbar-settings-label">更多设置</span></AppButton>
    </div>
    <div className="performance-transport" data-practice-chrome inert={!visible} aria-hidden={!visible}><span className="performance-tempo">{config.tempo} BPM</span>{props.children}</div>
    {settingsOpen && <SettingsDialog label="演奏设置" onClose={() => setSettingsOpen(false)}>
      <header className="performance-settings-heading"><div><h2>演奏设置</h2><p>按自己的节奏练习</p></div><AppButton type="button" className="pt-btn" onClick={() => setSettingsOpen(false)}>完成</AppButton></header>
      <div className="performance-settings-body">
      <AppButton type="button" className={`pt-btn pt-midi ${props.midiConnected ? 'on' : ''}`} onClick={props.onDevices} title={props.deviceLabel}><i />{props.midiConnected ? 'MIDI 已连接' : '连接 MIDI 键盘'}</AppButton>
    <div className="pt-group">
    {!props.performing && <AppButton type="button" className="pt-btn ghost" disabled={props.busy || locked} onClick={props.onToggleMode}>{fixedLine ? '固定线' : '读谱'} ⇄</AppButton>}
      <ChoiceSelect label="练习推进" value={props.systemDuet ? 'timeline' : config.advanceMode}
        disabled={locked || props.systemDuet || fixedLine} onValueChange={value => onPatch({ advanceMode: value as ScoreAdvanceMode })}
        options={[{ value: 'follow', label: '跟手' }, { value: 'timeline', label: '固定时间' }]} />
    </div>
      </div>
    </SettingsDialog>}
  </div>;
}
