import { AppButton } from './ui/controls';

export default function SessionControlNotice({ message, busy, onTakeover }: { message: string; busy: boolean; onTakeover: () => void }) {
  return <section className="card error-strip session-control-notice" role="alert">
    <strong>练习会话被占用</strong><p>{message}</p>
    <p>接管会结束原来的练习，并从当前页面重新开始。旧页面会停止自动开始。</p>
    <AppButton className="button button-primary" disabled={busy} onClick={onTakeover}>{busy ? '正在接管…' : '接管练习'}</AppButton>
  </section>;
}
