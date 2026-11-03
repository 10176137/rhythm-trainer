import { CaretRightOutlined as PlayIcon, BorderOutlined as StopIcon, UndoOutlined as ResetIcon } from '@ant-design/icons';
import { AppButton } from './ui/controls';
interface Props {
  startLabel: string; active: boolean; pending: boolean; disabled: boolean; error: string;
  onPlay: () => void; onStop: () => void; onFromStart: () => void;
}
export default function ScorePlaybackControls(props: Props) {
  return <div className="score-playback-controls" role="group" aria-label="谱面定位与试听">
    <span>{props.pending ? '正在保存当前轮次…' : props.startLabel}</span>
    <AppButton type="button" className="pt-btn" disabled={props.disabled || props.pending} onClick={props.active ? props.onStop : props.onPlay}>{props.active ? <StopIcon aria-hidden /> : <PlayIcon aria-hidden />}{props.active ? '停止试听' : '试听'}</AppButton>
    <AppButton type="button" className="pt-btn ghost" disabled={props.pending} onClick={props.onFromStart}><ResetIcon aria-hidden />从头开始</AppButton>
    {props.error && <span role="alert">{props.error}</span>}
  </div>;
}
