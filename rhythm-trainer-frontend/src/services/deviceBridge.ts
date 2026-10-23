// Frontend client for the Node MIDI device API. This is intentionally
// separate from EngineBridge: device enumeration/status and the input monitor
// exist before a practice session starts. Both use the same /ws endpoint.

export interface MidiDeviceInfo {
  id: string;
  name: string;
  state: 'available' | 'connected' | string;
}

export interface MidiAdapterStatus {
  backend: string;
  backendVersion: string;
  connected: boolean;
  device: MidiDeviceInfo | null;
  generation: number;
  inputHealth: string;
  queueDepth: number;
  queueCapacity: number;
  queueDropped: number;
  sourceSeq: number;
  clockDomainId: string;
  staleGenerationDropped: number;
  traceDropped: number;
  lastError: string | null;
}

export interface MidiInputEvent {
  sourceId: string;
  connectionGeneration: number;
  sourceSeq: number;
  capturedAtMonotonicMs: number;
  messageType: 'note-on' | 'note-off' | 'control-change' | 'other';
  channel: number;
  noteNumber: number | null;
  velocity: number | null;
  controllerNumber: number | null;
  controllerValue: number | null;
  rawData: number[];
}

export interface MidiDiagnostic {
  code: string;
  message: string;
  severity?: string;
}

export interface DeviceBridgeHandlers {
  onDevices: (items: MidiDeviceInfo[]) => void;
  onStatus: (status: MidiAdapterStatus) => void;
  onEvent: (event: MidiInputEvent) => void;
  onError: (error: { code: string; message: string }) => void;
  onDiagnostic: (diagnostic: MidiDiagnostic) => void;
}

export class DeviceBridge {
  private socket: WebSocket | null = null;
  private handlers: DeviceBridgeHandlers;
  private closed = false;
  private retryTimer: number | null = null;

  constructor(handlers: DeviceBridgeHandlers) {
    this.handlers = handlers;
    this.open();
  }

  private open() {
    if (this.closed) return;
    const socket = new WebSocket(`ws://${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      this.send({ type: 'midi-refresh' });
    };
    socket.onmessage = (event) => {
      let message: unknown;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object') return;
      const msg = message as Record<string, unknown>;
      switch (msg.type) {
        case 'midi-devices': {
          const items = Array.isArray(msg.items) ? msg.items as MidiDeviceInfo[] : [];
          this.handlers.onDevices(items);
          break;
        }
        case 'midi-status':
          this.handlers.onStatus(msg as unknown as MidiAdapterStatus);
          break;
        case 'midi-event':
          if (msg.event) this.handlers.onEvent(msg.event as MidiInputEvent);
          break;
        case 'midi-error':
          this.handlers.onError({
            code: String(msg.code ?? 'MIDI_ERROR'),
            message: String(msg.message ?? 'MIDI 设备错误'),
          });
          break;
        case 'diagnostic':
          this.handlers.onDiagnostic({
            code: String(msg.code ?? 'MIDI_DIAGNOSTIC'),
            message: String(msg.message ?? ''),
            severity: typeof msg.severity === 'string' ? msg.severity : undefined,
          });
          break;
        default:
          break;
      }
    };
    socket.onclose = () => {
      this.socket = null;
      if (this.closed || this.retryTimer !== null) return;
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = null;
        this.open();
      }, 1500);
    };
    socket.onerror = () => {
      // onclose handles the retry; keep the UI responsive.
    };
  }

  refresh() {
    this.send({ type: 'midi-refresh' });
  }

  connect(deviceId: string) {
    this.send({ type: 'midi-connect', deviceId });
  }

  disconnect() {
    this.send({ type: 'midi-disconnect' });
  }

  close() {
    this.closed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private send(payload: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ protocolVersion: 1, ...payload }));
  }
}
