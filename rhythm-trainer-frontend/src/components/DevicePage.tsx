import { useEffect, useMemo, useState } from 'react';
import type { MidiDeviceInfo, MidiInputEvent } from '../services/deviceBridge';

export interface HeldDeviceNote {
  noteNumber: number;
  since: number;
  velocity: number | null;
  channel: number;
}

interface Props {
  deviceStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  deviceName: string;
  deviceHealth: string;
  deviceError: string | null;
  portOptions: MidiDeviceInfo[];
  selectedPortId: string | null;
  isConnecting: boolean;
  nodeEvents: MidiInputEvent[];
  heldNotes: HeldDeviceNote[];
  onRefresh: () => void;
  onSelectPort: (id: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onBackToWorkbench: () => void;
}

const STUCK_NOTE_MS = 3000;
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

function noteName(midi: number | null | undefined): string {
  if (midi == null) return '—';
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function eventKind(event: MidiInputEvent): string {
  switch (event.messageType) {
    case 'note-on': return 'Note On';
    case 'note-off': return 'Note Off';
    case 'control-change': return 'Control Change';
    default: return 'Other';
  }
}

export default function DevicePage({
  deviceStatus,
  deviceName,
  deviceHealth,
  deviceError,
  portOptions,
  selectedPortId,
  isConnecting,
  nodeEvents,
  heldNotes,
  onRefresh,
  onSelectPort,
  onConnect,
  onDisconnect,
  onBackToWorkbench,
}: Props) {
  const [now, setNow] = useState(() => performance.now());
  const selected = portOptions.find((port) => port.id === selectedPortId) ?? null;
  const stuck = useMemo(
    () => heldNotes.filter((note) => now - note.since > STUCK_NOTE_MS),
    [heldNotes, now],
  );

  useEffect(() => {
    if (heldNotes.length === 0) return;
    const timer = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(timer);
  }, [heldNotes.length]);

  const statusLabel = deviceStatus === 'connected'
    ? '已连接'
    : deviceStatus === 'connecting'
      ? '连接中'
      : deviceStatus === 'error'
        ? '连接失败'
        : '未连接';

  return (
    <div className="page-content device-page">
      <div className="page-heading device-heading">
        <div>
          <div className="eyebrow">MIDI READY</div>
          <h1>设备检查</h1>
          <p>连接电子琴并确认应用真的收到了 Note On / Note Off；这里不会创建练习或报告。</p>
        </div>
        <button type="button" className="button button-ghost" onClick={onBackToWorkbench}>
          返回工作台
        </button>
      </div>

      <section className="card device-summary">
        <div className="device-summary-main">
          <span className={`device-readiness device-readiness-${deviceStatus}`} />
          <div>
            <strong>{deviceStatus === 'connected' ? deviceName : statusLabel}</strong>
            <p>
              {deviceStatus === 'connected'
                ? `输入健康：${deviceHealth} · ${selected?.name ?? deviceName}`
                : deviceStatus === 'error'
                  ? `连接失败：${deviceError ?? '未知错误'}`
                  : '请选择输入设备并连接；连接不会启动练习。'}
            </p>
          </div>
        </div>
        <div className="device-summary-actions">
          <button type="button" className="button button-outline" onClick={onRefresh} disabled={isConnecting}>
            刷新设备
          </button>
          {deviceStatus === 'connected' ? (
            <button type="button" className="button button-ghost" onClick={onDisconnect}>断开</button>
          ) : (
            <button type="button" className="button button-primary" onClick={onConnect} disabled={isConnecting || portOptions.length === 0}>
              {isConnecting ? '连接中…' : '连接设备'}
            </button>
          )}
        </div>
      </section>

      <div className="device-grid">
        <section className="card device-picker">
          <div className="card-heading"><div><div className="eyebrow">INPUT DEVICES</div><h3>可用输入设备</h3></div><span className="shortcut-key">{portOptions.length}</span></div>
          {portOptions.length === 0 ? (
            <div className="device-empty">
              <strong>没有可用的 MIDI 输入设备</strong>
              <p>确认电钢琴已开机、使用 USB TO HOST 数据线连接，并关闭其他占用端口的软件；然后点「刷新设备」。</p>
            </div>
          ) : (
            <div className="device-list" role="radiogroup" aria-label="MIDI 输入设备">
              {portOptions.map((port) => (
                <button
                  type="button"
                  key={port.id}
                  role="radio"
                  aria-checked={port.id === selectedPortId}
                  className={`device-option ${port.id === selectedPortId ? 'selected' : ''}`}
                  onClick={() => onSelectPort(port.id)}
                >
                  <span>{port.name}</span>
                  <small>{port.state === 'connected' ? '当前连接' : '可用'}</small>
                </button>
              ))}
            </div>
          )}
          <p className="device-note">设备连接和按键测试不会生成评分，也不会写入练习历史。</p>
        </section>

        <section className="card device-test">
          <div className="card-heading"><div><div className="eyebrow">KEY TEST</div><h3>按键测试</h3></div><span className={`device-test-status ${deviceStatus === 'connected' ? 'is-live' : ''}`}>{deviceStatus === 'connected' ? '监听中' : '等待连接'}</span></div>
          {deviceStatus !== 'connected' ? (
            <p className="device-empty-copy">连接设备后，按下琴键会显示音高、Note On/Off 和最近事件。</p>
          ) : (
            <>
              <div className="held-notes" aria-live="polite">
                <span className="small-label">当前按下</span>
                {heldNotes.length === 0
                  ? <strong className="held-none">没有按下的键</strong>
                  : heldNotes.map((note) => (
                    <span className="held-note" key={`${note.noteNumber}-${note.since}`}>
                      {noteName(note.noteNumber)} <small>v{note.velocity ?? '—'}</small>
                    </span>
                  ))}
              </div>
              {stuck.length > 0 && (
                <p className="device-warning" role="status">
                  已超过 3 秒未收到 {stuck.map((note) => noteName(note.noteNumber)).join(' / ')} 的 Note Off。
                  这可能只是持续按键；如果已经松键，请检查设备连接或输入事件。当前不会因此直接判定设备故障。
                </p>
              )}
              <div className="device-events">
                <div className="device-events-title">最近输入</div>
                {nodeEvents.length === 0 ? (
                  <p className="device-empty-copy">还没有按键事件。请按下一个琴键，再松开。</p>
                ) : (
                  <div className="device-event-list">
                    {nodeEvents.map((event) => (
                      <div className="device-event-row" key={`${event.sourceId}-${event.sourceSeq}`}>
                        <span>{eventKind(event)}</span>
                        <strong>{event.messageType === 'note-on' || event.messageType === 'note-off' ? noteName(event.noteNumber) : '—'}</strong>
                        <span>v{event.velocity ?? '—'}</span>
                        <span>#{event.sourceSeq}</span>
                        <span>{event.channel + 1}ch</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <section className="card device-guidance">
        <strong>设备就绪不等于练习就绪</strong>
        <p>
          开始练习时，工作台仍会校验当前曲谱、目标时间表、配置快照和输入连接。
          设备断开、队列溢出或时钟不稳定会被标记为输入降级；不会把系统问题当成用户弹错。
        </p>
      </section>
    </div>
  );
}
