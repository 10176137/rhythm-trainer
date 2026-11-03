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
    <span className="practice-session-state" role="status">{props.waitingForFirstInput && running ? '弹对起点音符即开始' : props.statusLabel}</span>
    <span className="practice-session-elapsed">{`${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`}</span>
    {preparing !== null ? <button type="button" className="pt-btn primary" disabled>准备 {preparing}s</button>
      : running ? <button type="button" className="pt-btn primary" onClick={props.onPause}>暂停</button>
      : status === 'paused' ? <button type="button" className="pt-btn primary" onClick={props.onResume}>继续</button>
      : props.automaticStart ? null : <button type="button" className="pt-btn primary" disabled={busy || props.startDisabled} onClick={props.onStart}>{status === 'completed' ? '再练一次' : '开始练习'}</button>}
    <button type="button" className="pt-btn ghost" disabled={busy || (status === 'idle' && preparing === null) || status === 'completed'}
      onClick={preparing !== null && !props.active ? props.onCancelPreparation : props.onFinish}>结束</button>
    <button type="button" className="pt-btn ghost" disabled={props.locked || busy} onClick={props.onReset}>重置</button>
  </div>;
}
