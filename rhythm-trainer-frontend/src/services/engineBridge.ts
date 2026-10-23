// WebSocket bridge to the local engine service. The service hosts the Rust
// core; this client never scores anything itself. All times are session-
// relative milliseconds (performance.now() anchored at session start).

import type {
  EngineClientMessage,
  EngineProfile,
  EngineReportMessage,
  EngineScoringConfig,
  EngineServerMessage,
  EngineAtom,
  EngineJudgment,
  EngineTarget,
  DurationEvaluationPolicy,
  EngineIngestMidiPacket,
  EngineScoreEvent,
} from '../types/engine';
import type { HandSelection } from '../types/practice';
import type { TeachingPrescription } from '../types/teaching';

export interface EngineStartTiming {
  /** First note onset from the backend schedule, relative to the session origin. */
  firstTargetAtMs: number | null;
  countInMs: number;
}

export interface EngineHandlers {
  onStarted: (targets: EngineTarget[], bpm: number, profile: EngineProfile, captureEpoch?: number, scoringConfig?: EngineScoringConfig, timing?: EngineStartTiming) => void;
  onJudgments: (items: EngineJudgment[]) => void;
  onPaused: () => void;
  onResumed: (deltaMs: number) => void;
  onReport: (message: EngineReportMessage) => void;
  onError: (message: string) => void;
  onDisconnected: () => void;
}

export class EngineBridge {
  private socket: WebSocket | null = null;
  private handlers: EngineHandlers;
  private clockPingSeq = 0;

  constructor(handlers: EngineHandlers) {
    this.handlers = handlers;
  }

  connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.startClockSync(this.socket);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(`ws://${location.host}/ws`);
      socket.onopen = () => {
        settled = true;
        this.socket = socket;
        this.startClockSync(socket);
        resolve();
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('无法连接本地引擎服务。请先运行 npm run server,再刷新页面。'));
        }
      };
      socket.onclose = () => {
        this.socket = null;
        this.handlers.onDisconnected();
      };
      socket.onmessage = (event) => {
        let message: EngineServerMessage;
        try {
          message = JSON.parse(event.data) as EngineServerMessage;
        } catch {
          return;
        }
        switch (message.type) {
          case 'started':
            this.handlers.onStarted(
              message.targets,
              message.bpm,
              message.profile,
              message.captureEpoch,
              message.scoringConfig,
              {
                firstTargetAtMs: typeof message.firstTargetAtMs === 'number' && Number.isFinite(message.firstTargetAtMs)
                  ? message.firstTargetAtMs
                  : null,
                countInMs: Number.isFinite(message.countInMs) ? message.countInMs : 0,
              },
            );
            break;
          case 'judgments':
            this.handlers.onJudgments(message.items);
            break;
          case 'paused':
            this.handlers.onPaused();
            break;
          case 'resumed':
            this.handlers.onResumed(message.deltaMs);
            break;
          case 'clock-pong':
            this.send({ protocolVersion: 1, type: 'clock-sample', id: message.id, clientReceivePerfMs: performance.now() });
            break;
          case 'report':
            this.handlers.onReport(message);
            break;
          case 'error':
            this.handlers.onError(message.message);
            break;
          default:
            break;
        }
      };
    });
  }

  /** 10 lightweight four-timestamp samples; the server keeps the low-RTT one. */
  private startClockSync(socket: WebSocket) {
    for (let index = 0; index < 10; index += 1) {
      window.setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        this.clockPingSeq += 1;
        const id = `clock-${this.clockPingSeq}-${Math.random().toString(36).slice(2, 8)}`;
        socket.send(JSON.stringify({ protocolVersion: 1, type: 'clock-ping', id, clientSendPerfMs: performance.now() }));
      }, index * 12);
    }
  }

  /** Browser performance time at session 0, used to map Node MIDI capture time. */
  sessionOrigin(clientPerfMs: number) {
    this.send({ protocolVersion: 1, type: 'session-origin', clientPerfMs });
  }

  private send(message: EngineClientMessage) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  start(request: {
    modeId: string;
    bpm: number;
    profile: EngineProfile;
    countInBeats: number;
    ticksPerQuarter: number;
    atoms: EngineAtom[];
    scoreEvents?: EngineScoreEvent[];
    assisted?: boolean;
    durationPolicy?: DurationEvaluationPolicy;
    scoreFingerprint?: string;
    playbackPlanId?: string;
    scoreImportStatus?: string;
    hand?: HandSelection;
    scoreBarCount?: number;
    sourceReportId?: string;
    sourceTakeId?: string;
    prescriptionId?: string;
    prescription?: TeachingPrescription;
    takeTemplateId?: string;
  }) {
    this.send({ type: 'start', ...request });
  }

  hit(seq: number, atMs: number, notes: number[]) {
    this.send({ type: 'hit', seq, atMs, notes });
  }

  /** v0.3 raw note event for key-down duration pairing (never scored live). */
  /** v0.6 authoritative input: raw packet + clock mapping (decoded in Rust). */
  sendRawMidi(ingest: EngineIngestMidiPacket) {
    this.send({ type: 'raw-midi', ingest });
  }

  /** v0.3 legacy path — superseded by sendRawMidi; kept for old clients. */
  noteEvent(seq: number, atMs: number, kind: 'note-on' | 'note-off', pitch: number, velocity?: number) {
    if (kind === 'note-on') {
      this.send({ type: 'note-on', seq, atMs, pitch, velocity });
    } else {
      this.send({ type: 'note-off', seq, atMs, pitch });
    }
  }

  tick(nowMs: number) {
    this.send({ type: 'tick', nowMs });
  }

  pause(nowMs: number, atSourceMs?: number) {
    this.send({ type: 'pause', nowMs, ...(atSourceMs != null ? { atSourceMs } : {}) });
  }

  resume(nowMs: number, atSourceMs?: number) {
    this.send({ type: 'resume', nowMs, ...(atSourceMs != null ? { atSourceMs } : {}) });
  }

  finish() {
    this.send({ type: 'finish' });
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }
}
