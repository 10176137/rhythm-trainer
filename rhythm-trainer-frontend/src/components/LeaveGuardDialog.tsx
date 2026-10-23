import { useEffect, useRef } from 'react';

interface Props {
  open: boolean;
  busy: boolean;
  processing: boolean;
  error: string | null;
  onStay: () => void;
  onFinishAndLeave: () => void;
}

export default function LeaveGuardDialog({
  open,
  busy,
  processing,
  error,
  onStay,
  onFinishAndLeave,
}: Props) {
  const stayRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) stayRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="leave-backdrop" role="presentation">
      <section
        className="card leave-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-dialog-title"
        aria-describedby="leave-dialog-description"
      >
        <div className="eyebrow">UNFINISHED PRACTICE</div>
        <h2 id="leave-dialog-title">结束当前练习？</h2>
        <p id="leave-dialog-description">
          当前轮次尚未结束。离开会调用现有的停止与结算流程；只有报告成功生成并持久化后才会导航。
          不会恢复未完成 Take。
        </p>
        {processing && <p className="leave-progress">正在生成报告，请稍候…</p>}
        {error && <p className="report-warning" role="alert">{error}</p>}
        <div className="leave-dialog-actions">
          <button ref={stayRef} type="button" className="button button-outline" onClick={onStay} >
            留在练习室
          </button>
          <button type="button" className="button button-primary" onClick={onFinishAndLeave} disabled={busy}>
            {busy ? '正在结束…' : processing ? '等待报告并离开' : '结束本轮并离开'}
          </button>
        </div>
      </section>
    </div>
  );
}
