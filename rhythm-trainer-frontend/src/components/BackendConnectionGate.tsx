import { Capacitor } from '@capacitor/core';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { activateBackendOrigin, BACKEND_DISCONNECTED_EVENT, probeBackend } from '../services/backendEndpoint';

const ADDRESS_KEY = 'rhythm-trainer.computer-origin.v1';
function savedAddress(): string {
  try { return localStorage.getItem(ADDRESS_KEY) ?? ''; } catch { return ''; }
}

/** A local connection screen is available even when the computer is offline.
 * App is mounted only after a successful probe, so no business requests escape
 * to capacitor://localhost or to a previously entered address. */
function NativeBackendGate({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState(savedAddress);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [interrupted, setInterrupted] = useState(false);
  const [changing, setChanging] = useState(false);
  const attempt = useRef<AbortController | null>(null);
  const connectedRef = useRef(false);

  useEffect(() => () => attempt.current?.abort(), []);
  useEffect(() => {
    const disconnected = () => {
      attempt.current?.abort();
      attempt.current = null;
      setBusy(false);
      if (connectedRef.current) {
        connectedRef.current = false;
        setInterrupted(true);
      }
    };
    const lifecycleChanged = () => disconnected();
    window.addEventListener(BACKEND_DISCONNECTED_EVENT, disconnected);
    window.addEventListener('offline', disconnected);
    document.addEventListener('visibilitychange', lifecycleChanged);
    return () => {
      window.removeEventListener(BACKEND_DISCONNECTED_EVENT, disconnected);
      window.removeEventListener('offline', disconnected);
      document.removeEventListener('visibilitychange', lifecycleChanged);
    };
  }, []);

  const returnToConnection = () => {
    connectedRef.current = false;
    setConnected(false);
    setInterrupted(false);
    setChanging(false);
    setError('');
    // A full document reload cancels old async continuations before a different
    // computer can be activated. An unmount alone does not cancel promises.
    window.location.reload();
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(true);
    setError('');
    try {
      const origin = await probeBackend(address, controller.signal);
      if (controller.signal.aborted || attempt.current !== controller || document.visibilityState === 'hidden') return;
      activateBackendOrigin(origin);
      try { localStorage.setItem(ADDRESS_KEY, origin); } catch { /* usable without persistence */ }
      setAddress(origin);
      connectedRef.current = true;
      setConnected(true);
    } catch (reason) {
      if (attempt.current !== controller) return;
      setError(reason instanceof Error && !(reason instanceof TypeError) && reason.name !== 'AbortError'
        ? reason.message
        : '无法连接电脑，请确认服务已启动、两台设备网络互通，并允许 App 访问本地网络。');
    } finally {
      if (attempt.current === controller) setBusy(false);
    }
  };

  if (!connected) return <main className="computer-connection">
    <form className="computer-connection-card" onSubmit={connect}>
      <span className="computer-connection-mark" aria-hidden="true">♫</span>
      <h1>连接练习电脑</h1>
      <p>琴连接电脑，iPad 用来看谱和练习。</p>
      <label htmlFor="computer-address">电脑服务地址</label>
      <input id="computer-address" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        required placeholder="http://192.168.1.20:8788" value={address}
        onChange={(event) => {
          attempt.current?.abort(); attempt.current = null; setBusy(false); setError(''); setAddress(event.target.value);
        }} aria-describedby="computer-connection-help" />
      <small id="computer-connection-help">填写电脑启动服务后显示的局域网地址。电脑需保持运行。</small>
      {error && <p className="computer-connection-error" role="alert">{error}</p>}
      <button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在连接…' : '连接并开始'}</button>
    </form>
  </main>;

  return <div className="native-app">
    <div className="native-app-content" inert={interrupted || changing}>{interrupted ? null : children}</div>
    <button className="native-computer-button" type="button" disabled={interrupted || changing} onClick={() => setChanging(true)} aria-label="更换练习电脑">连接设置</button>
    {(interrupted || changing) && <div className="computer-connection-overlay">
      <section className="computer-connection-card" role="alertdialog" aria-modal="true" aria-labelledby="computer-reconnect-title">
        <h2 id="computer-reconnect-title">{interrupted ? '请重新确认连接' : '更换练习电脑？'}</h2>
        <p>{interrupted ? '连接曾中断或 App 已从后台返回。重新连接会退出当前练习，不会自动重放演奏操作。' : '返回连接页会退出当前练习。已在电脑保存的记录仍然保留。'}</p>
        <button className="button button-primary" autoFocus onClick={returnToConnection}>返回连接页</button>
        {!interrupted && <button className="button button-ghost" onClick={() => setChanging(false)}>继续练习</button>}
      </section>
    </div>}
  </div>;
}

export default function BackendConnectionGate({ children }: { children: ReactNode }) {
  return Capacitor.isNativePlatform() ? <NativeBackendGate>{children}</NativeBackendGate> : children;
}
