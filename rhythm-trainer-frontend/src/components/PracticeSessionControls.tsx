import { PauseOutlined as PauseIcon, CaretRightOutlined as PlayIcon } from '@ant-design/icons';
import { AppButton } from './ui/controls';
import type { SessionStatus } from '../types/practice';
import './practiceSessionControls.css';

interface Props {
  status: SessionStatus;
  statusLabel: string;
  elapsed: number;
  starting: boolean;
  preparing: number | null;
  active: boolean;
  waitingForFirstInput?: boolean;
  automaticStart?: boolean;
  locked: boolean;
  startDisabled?: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  onCancelPreparation: () => void;
  onReset: () => void;
}

/** Session actions shared by performance, generated reading and training.
 * This component only renders the session owner's state and callbacks. */
export default function PracticeSessionControls(props: Props) {
  const { status, preparing } = props;
  const running = status === 'running' || status === 'countdown';
  const busy = props.starting || status === 'processing';
  const seconds = Math.max(0, Math.floor(props.elapsed));
  return <div className="practice-session-controls" role="group" aria-label="练习会话控制">
    <span className="practice-session-state" role="status">{props.waitingForFirstInput && running ? '等待起奏 · 弹对起点音符即开始' : props.statusLabel}</span>
    <span className="practice-session-elapsed">{`${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`}</span>
    {preparing !== null ? <AppButton type="button" className="pt-btn primary" disabled>准备 {preparing}s</AppButton>
      : running && props.waitingForFirstInput ? null
      : running ? <AppButton type="button" className="pt-btn primary" onClick={props.onPause}><PauseIcon aria-hidden />暂停</AppButton>
      : status === 'paused' ? <AppButton type="button" className="pt-btn primary" onClick={props.onResume}><PlayIcon aria-hidden />继续</AppButton>
      : props.automaticStart ? null : <AppButton type="button" className="pt-btn primary" disabled={busy || props.startDisabled} onClick={props.onStart}>{status === 'completed' ? '再练一次' : '开始练习'}</AppButton>}
    <AppButton type="button" className="pt-btn ghost" disabled={busy || (status === 'idle' && preparing === null) || status === 'completed'}
      onClick={preparing !== null && !props.active ? props.onCancelPreparation : props.onFinish}>{props.waitingForFirstInput && running ? '取消' : '结束'}</AppButton>
    {!props.automaticStart && <AppButton type="button" className="pt-btn ghost" disabled={props.locked || busy} onClick={props.onReset}>重置</AppButton>}
  </div>;
}
