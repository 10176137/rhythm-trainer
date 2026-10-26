import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ScoreViewer from './components/ScoreViewer';
import ReportPanel from './components/ReportPanel';
import HistoryView from './components/HistoryView';
import ProfileView from './components/ProfileView';
import FollowReportPanel from './components/FollowReportPanel';
import AppShell from './components/AppShell';
import RoutePlaceholder from './components/RoutePlaceholder';
import ScoreLibraryPage from './components/ScoreLibraryPage';
import ReaderPage from './components/ReaderPage';
import DevicePage, { type HeldDeviceNote } from './components/DevicePage';
import LeaveGuardDialog from './components/LeaveGuardDialog';
import { useAppRoute } from './app/useAppRoute';
import { NAV_ROUTES } from './app/routes';
import { modeList, modeRegistry } from './config/modeRegistry';
import type { ScoreDocument } from './core/sampleScore';
import { buildPracticePlan } from './features/score/practicePlan';
import { practiceScoreDocument } from './features/score/practiceScore';
import { applyHandMappingToLegacyNotes } from './score-engine/legacy-bridge';
import { buildPlaybackPlan, TS_PLANNER_VERSION } from './score-engine/playback/playback-planner';
import { projectScoreDocumentV1 } from './score-engine/contract-v1/plan-fingerprint';
import {
  assertFollowResponseUsable,
  assertTimelineResponseUsable,
  rangeSpanFromDocument,
  toPlaybackPlan,
} from './score-engine/plan/rust-plan';
import {
  assertPracticePlanBundle,
  buildPracticePlanBundleFromPlayback,
  buildPracticePlanBundleFromRust,
  engineAtomsFromBundle,
  engineScoreEventsFromBundle,
  type BundleConfigInput,
} from './score-engine/plan/practice-plan-bundle';
import {
  decideAuthority,
  orchestrateRustLaunch,
  planContextKey,
} from './score-engine/plan/launch-flow';
import {
  buildReferencePlaybackPlan,
  filterPlaybackPlanByHand,
  type ReferencePlaybackPlan,
} from './score-engine/playback/reference-playback-plan';
import { FollowSession, type FollowNoteResult, type FollowReport } from './score-engine/practice/follow-session';
import type { PlaybackGroup } from './score-engine/domain/types';
import { toNumber } from './score-engine/domain/rational';
import TeachingWorkspace, { type TeachingTakeNotice } from './components/TeachingWorkspace';
import { saveLastRunId } from './services/teachingRunRepository';
import { WebAudioEngineAdapter } from './features/playback/audioEngineAdapter';
import {
  ReferencePlaybackController,
  type PlaybackDiagnostic,
  type PlaybackSnapshot,
} from './features/playback/reference-playback-controller';
import { ensureSharedAudioContext } from './features/playback/sharedAudioContext';
import { parseMusicXml } from './features/score/musicXmlParser';
import { importScoreText } from './features/score/scoreImport';
import { summarizeImportReport } from './features/score/scoreStatus';
import {
  createScoreLibraryEntry,
  deleteScoreLibraryEntry,
  getScoreLibraryEntry,
  listScoreLibrary,
  loadStoredActiveScoreId,
  saveStoredActiveScoreId,
  ScoreLibraryClientError,
  updateScoreLibraryEntry,
  type ScoreLibraryEntry,
} from './features/score/scoreLibrary';
import ledgerDemoXml from './features/score/fixtures/ledger-lines-demo.musicxml?raw';
import { getUnsupportedNotes } from './features/score/staffMapping';
import { assessPracticeScope, buildUserHandMapping, handByScoreEventIdFromMapping, suggestClefHeuristicMapping, type PracticeHand, type HandMappingV1 } from './score-engine/scope/practice-scope';
import {
  loadScoreHintOverrides,
  resolveScoreHints,
  saveScoreHintOverrides,
  type ScoreHintOverrides,
} from './features/score/scoreHints';
import { DeviceBridge } from './services/deviceBridge';
import type { MidiAdapterStatus, MidiDeviceInfo, MidiInputEvent } from './services/deviceBridge';
import { takeTemplateRepository, TakeTemplateClientError, type TakeTemplate } from './services/takeTemplateRepository';
import { usePracticeSession } from './features/practice/usePracticeSession';
import { countdownToFirstNoteMs, countdownWholeSeconds, countInBeatsForTempo, DEFAULT_COUNT_IN_MS } from './features/practice/countdown';
import { SystemDuetPlayer } from './features/practice/systemDuet';
import {
  loadPracticeSettings,
  savePracticeSettings,
  type PersistedPracticeSettings,
} from './features/practice/practiceSettings';
import type { EngineRawMidiPacket, FollowEventMessage, FollowGroupRequest, FollowReportMessage } from './types/engine';
import type { DurationEvaluationPolicy, FeedbackMessage, FeedbackMode, HandSelection, JudgmentProfile, MidiPerformanceEvent, PracticeConfig, PracticeModeId, SessionStatus } from './types/practice';

const formatTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const noteForMidi = (midi: number) => {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
};

// Hand and loop are configuration of score practice, not separate modes.
const visibleModes = modeList.filter((mode) => mode.id === 'rhythm' || mode.id === 'score' || mode.id === 'free');

function engineModeFor(config: PracticeConfig): PracticeModeId {
  if (config.modeId !== 'score') return config.modeId;
  if (config.loopEnabled) return 'loop';
  if (config.hand !== 'both') return 'hands';
  return 'score';
}

/** Follow plan projection sent to the engine. This is presentation input;
 * the server validates it and records it as a client projection, never as a
 * Rust plan. */
function toFollowGroupRequests(groups: readonly PlaybackGroup[]): FollowGroupRequest[] {
  return groups.map((group) => ({
    groupId: group.groupId,
    bar: group.bar,
    playbackBeat: toNumber(group.playbackBeat),
    pitches: group.pitches
      .filter((pitch): pitch is typeof pitch & { midiNote: number } => pitch.midiNote !== null)
      .map((pitch) => ({ midiNote: pitch.midiNote, spelling: pitch.spelling })),
  }));
}

export default function App() {
  const [initialSettings] = useState(loadPracticeSettings);
  const [staffMappingOverrides, setStaffMappingOverrides] = useState<Record<number, 'left' | 'right'>>({});
  const [handMappings, setHandMappings] = useState<Record<string, HandMappingV1>>(() => {
    const raw = initialSettings.handMappings ?? {};
    const out: Record<string, HandMappingV1> = {};
    for (const [fingerprint, value] of Object.entries(raw)) {
      // Canonical persisted form is the parts array. Accept the earlier
      // whole-HandMappingV1 shape too so a stored confirmation is not lost.
      const parts = Array.isArray(value)
        ? value
        : value && typeof value === 'object' && Array.isArray((value as { parts?: unknown }).parts)
          ? (value as { parts: unknown[] }).parts
          : null;
      if (!parts) continue;
      out[fingerprint] = { schemaVersion: 1, mappingVersion: 'hand-mapping-1', source: 'user', parts: parts as HandMappingV1['parts'] };
    }
    return out;
  });
  const rememberHandMapping = (fingerprint: string, mapping: HandMappingV1) => {
    setHandMappings((prev) => {
      const next = { ...prev, [fingerprint]: mapping };
      // Merge into the persisted file without touching live config/metronome
      // refs (they are declared later); settings saves elsewhere write both.
      try {
        const persisted = loadPracticeSettings();
        savePracticeSettings({
          config: persisted.config,
          metronomeOn: persisted.metronomeOn,
          handMappings: Object.fromEntries(
            Object.entries(next).map(([key, value]) => [key, value.parts]),
          ),
        });
      } catch { /* best effort */ }
      return next;
    });
  };
  /** Explicit user mapping for the given score, or null. Never guesses. */
  const userHandMappingFor = (fingerprint: string, partId: string): HandMappingV1 | null => {
    const stored = handMappings[fingerprint];
    if (stored && stored.source === 'user' && stored.parts.some((part) => part.partId === partId)) return stored;
    return null;
  };
  const [config, setConfig] = useState<PracticeConfig>(initialSettings.config);
  const [scoreDoc, setScoreDoc] = useState<ScoreDocument>(practiceScoreDocument);
  // Display hand must match the explicit staff→hand mapping the planner uses.
  // The import bridge only knows the piano staff default; re-apply the user's
  // mapping whenever it is confirmed or a score is loaded. The helper returns
  // the same array when nothing changes, so this cannot loop.
  useEffect(() => {
    setScoreDoc((prev) => {
      if (!prev.engine) return prev;
      const partId = prev.engine.parts[0]?.id ?? 'P1';
      const stored = handMappings[prev.engine.fingerprint];
      const mapping = stored && stored.source === 'user' && stored.parts.some((part) => part.partId === partId)
        ? stored
        : null;
      if (!mapping) return prev;
      const notes = applyHandMappingToLegacyNotes(prev.notes, prev.engine, mapping);
      return notes === prev.notes ? prev : { ...prev, notes };
    });
  }, [handMappings, scoreDoc.engine]);
  const [hintOverrides, setHintOverrides] = useState<ScoreHintOverrides>(() => loadScoreHintOverrides());
  const scoreHints = resolveScoreHints(hintOverrides, config.profile);
  const [lastInputMidi, setLastInputMidi] = useState<number | null>(null);
  const [followPulse, setFollowPulse] = useState(0);
  const [prepRemain, setPrepRemain] = useState<number | null>(null);
  const prepTimerRef = useRef<number | null>(null);
  const [systemDuet, setSystemDuet] = useState(() => {
    try { return window.localStorage.getItem('rhythm-trainer.system-duet.v1') !== '0'; } catch { return true; }
  });
  const [systemAudio, setSystemAudio] = useState(() => {
    try { return window.localStorage.getItem('rhythm-trainer.system-audio.v1') !== '0'; } catch { return true; }
  });
  const [systemNoteIds, setSystemNoteIds] = useState<string[]>([]);
  const [userNoteIds, setUserNoteIds] = useState<string[]>([]);
  const [referenceSnapshot, setReferenceSnapshot] = useState<PlaybackSnapshot | null>(null);
  const systemPlayerRef = useRef<SystemDuetPlayer | null>(null);
  const referencePlaybackRef = useRef<ReferencePlaybackController | null>(null);
  const referencePlanRef = useRef<ReferencePlaybackPlan | null>(null);
  const pendingReferencePlanRef = useRef<ReferencePlaybackPlan | null>(null);
  const referenceMarkedIndexRef = useRef(0);
  const pauseSessionForAudioRef = useRef<() => void>(() => {});
  const systemAudioRef = useRef(systemAudio);
  systemAudioRef.current = systemAudio;
  const duetTimersRef = useRef<number[]>([]);
  const [followStatus, setFollowStatus] = useState<SessionStatus>('idle');
  const [followReport, setFollowReport] = useState<FollowReport | null>(null);
  const [followPersistence, setFollowPersistence] = useState<{
    takeId: string;
    persisted: boolean;
    status: string;
    error: string | null;
  } | null>(null);
  const [followRetrying, setFollowRetrying] = useState(false);
  /** The last finished Take of this visit, offered to the teaching workspace. */
  const [teachingTakeNotice, setTeachingTakeNotice] = useState<TeachingTakeNotice | null>(null);
  const [followView, setFollowView] = useState<{
    index: number;
    total: number;
    completed: number;
    currentGroup: PlaybackGroup | null;
    last: FollowNoteResult | null;
  } | null>(null);
  const followGroupsRef = useRef<readonly PlaybackGroup[]>([]);
  const followStartSeqRef = useRef(0);
  const guideSessionRef = useRef<FollowSession | null>(null);
  /** R2-3h: the server's planner authority, fetched once (null = unknown).
   * The browser keeps NO second switch; rust is only used when the server
   * says so, and an unknown state never silently plans with TS. */
  const plannerAuthorityRef = useRef<'rts' | 'rust' | null>(null);
  /** R2-3h-R1: monotonic probe generation — a slower/older status answer can
   * never overwrite a newer one, and a disconnect invalidates the cache. */
  const plannerAuthoritySeqRef = useRef(0);
  /** R2-3h-R1: launch generation — a newer launch supersedes any in-flight
   * plan request from an older one. */
  const launchSeqRef = useRef(0);
  /** R2-3h-R1: the CURRENT score selection, read after a plan response
   * arrives (a closure-captured fingerprint cannot prove that). */
  const scoreDocRef = useRef(scoreDoc);
  scoreDocRef.current = scoreDoc;
  const sessionScoreFingerprintRef = useRef<string | null>(null);
  useEffect(() => {
    sessionScoreFingerprintRef.current = scoreDocRef.current.engine?.fingerprint ?? null;
  }, [scoreDoc.engine?.fingerprint]);
  const systemDuetRef = useRef(systemDuet);
  systemDuetRef.current = systemDuet;
  const [guideView, setGuideView] = useState<{ index: number; currentGroup: PlaybackGroup | null; completed: number } | null>(null);
  const followStatusRef = useRef<SessionStatus>('idle');
  followStatusRef.current = followStatus;
  const routeGuardRef = useRef<(nextPath: string) => boolean>(() => true);
  const { path: routePath, route, navigate } = useAppRoute({
    canLeave: (nextPath) => routeGuardRef.current(nextPath),
  });
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [events, setEvents] = useState<MidiPerformanceEvent[]>([]);
  const [feedbackItems, setFeedbackItems] = useState<FeedbackMessage[]>([
    { id: 'welcome', title: '准备就绪', detail: '评分由本地 Rust 引擎服务完成。连接 MIDI 键盘或使用模拟输入开始练习。', tone: 'neutral', timestampMs: 0 },
  ]);
  const [deviceStatus, setDeviceStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [deviceName, setDeviceName] = useState('尚未连接');
  const [deviceHealth, setDeviceHealth] = useState('unknown');
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [nodeEvents, setNodeEvents] = useState<MidiInputEvent[]>([]);
  const [heldDeviceNotes, setHeldDeviceNotes] = useState<HeldDeviceNote[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<PersistedPracticeSettings | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [pitchMismatch, setPitchMismatch] = useState(false);
  const [inputNote, setInputNote] = useState('—');
  const [metronomeOn, setMetronomeOn] = useState(initialSettings.metronomeOn);
  const [isConnecting, setIsConnecting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [leaveRequest, setLeaveRequest] = useState<{ targetPath: string } | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const pendingLeaveRef = useRef<string | null>(null);
  const pendingFinishIssuedRef = useRef(false);
  const [portOptions, setPortOptions] = useState<MidiDeviceInfo[]>([]);
  const [selectedPortId, setSelectedPortId] = useState<string | null>(null);
  const [scoreLibrary, setScoreLibrary] = useState<ScoreLibraryEntry[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState('');
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);
  const [scoreRestoreState, setScoreRestoreState] = useState<'loading' | 'ready'>(() => (
    loadStoredActiveScoreId() ? 'loading' : 'ready'
  ));
  const scoreSelectionVersionRef = useRef(0);
  const [scoreLibraryBusy, setScoreLibraryBusy] = useState(false);
  const [scoreLibraryError, setScoreLibraryError] = useState<string | null>(null);
  const [replaceLibraryTarget, setReplaceLibraryTarget] = useState<string | null>(null);
  const [takeTemplates, setTakeTemplates] = useState<TakeTemplate[]>([]);
  const [selectedTakeTemplateId, setSelectedTakeTemplateId] = useState('');
  const [appliedTakeTemplateId, setAppliedTakeTemplateId] = useState<string | null>(null);
  const [takeTemplateBusy, setTakeTemplateBusy] = useState(false);
  const [takeTemplateError, setTakeTemplateError] = useState<string | null>(null);
  const autoAppliedTakeTemplateRef = useRef(false);
  const deviceBridgeRef = useRef<DeviceBridge | null>(null);
  const scoreFileInputRef = useRef<HTMLInputElement | null>(null);
  const libraryReplaceInputRef = useRef<HTMLInputElement | null>(null);
  const mockSeqRef = useRef(0);
  const selectedPortIdRef = useRef<string | null>(null);
  const sessionIndexRef = useRef(0);
  const displayStartRef = useRef<number | null>(null);
  const elapsedBeforePauseRef = useRef(0);
  const expectedNotesRef = useRef<{ midiNote: number; noteName: string }[][]>([]);
  const planGroupsRef = useRef<string[][]>([]);
  const lastExtraFeedbackRef = useRef(0);

  const addFeedback = useCallback((title: string, detail: string, tone: FeedbackMessage['tone']) => {
    const item = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, title, detail, tone, timestampMs: performance.now() };
    setFeedbackItems(prev => [item, ...prev].slice(0, 6));
  }, []);

  const markSystemNotes = useCallback((ids: readonly string[] | undefined) => {
    if (!ids?.length) return;
    setSystemNoteIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? [...next] : prev;
    });
  }, []);

  const clearDuetTimers = () => {
    for (const timer of duetTimersRef.current) window.clearTimeout(timer);
    duetTimersRef.current = [];
  };

  const clearReferencePlayback = useCallback((reason: string) => {
    referencePlaybackRef.current?.stop(reason);
    setReferenceSnapshot(null);
    referencePlanRef.current = null;
    pendingReferencePlanRef.current = null;
    referenceMarkedIndexRef.current = 0;
  }, []);

  const markUserNotes = useCallback((ids: readonly string[] | undefined) => {
    if (!ids?.length) return;
    setUserNoteIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? [...next] : prev;
    });
  }, []);

  const cancelPrep = () => {
    if (prepTimerRef.current !== null) {
      window.clearTimeout(prepTimerRef.current);
      prepTimerRef.current = null;
    }
    setPrepRemain(null);
  };

  const toggleSystemAudio = () => {
    const next = !systemAudio;
    setSystemAudio(next);
    try { window.localStorage.setItem('rhythm-trainer.system-audio.v1', next ? '1' : '0'); } catch { /* best effort */ }
    referencePlaybackRef.current?.setGain(next ? 1 : 0);
    if (next) {
      systemPlayerRef.current ??= new SystemDuetPlayer();
      systemPlayerRef.current.ensure();
    } else {
      systemPlayerRef.current?.stopAll();
    }
  };

  const toggleSystemDuet = () => {
    const next = !systemDuet;
    setSystemDuet(next);
    try { window.localStorage.setItem('rhythm-trainer.system-duet.v1', next ? '1' : '0'); } catch { /* best effort */ }
    if (next) {
      void ensureSharedAudioContext().catch((error) => {
        addFeedback('音频引擎不可用', error instanceof Error ? error.message : String(error), 'warning');
      });
      systemPlayerRef.current ??= new SystemDuetPlayer();
      systemPlayerRef.current.ensure();
      referencePlaybackRef.current?.setGain(systemAudioRef.current ? 1 : 0);
      if (config.advanceMode !== 'timeline') {
        addFeedback('系统伴弹使用固定时间', '系统需要连续演奏，已切换为「固定时间」推进；当前练习请重置后重新开始。', 'neutral');
      } else if (session.active || followStatusRef.current === 'running' || followStatusRef.current === 'paused' || followStatusRef.current === 'processing') {
        addFeedback('系统伴弹将在下次生效', '当前练习已在进行中；请结束后重新开始以启动参考播放。', 'neutral');
      }
    } else {
      referencePlaybackRef.current?.stop('system-duet-off');
      setReferenceSnapshot(null);
      systemPlayerRef.current?.stopAll();
      clearDuetTimers();
      setSystemNoteIds([]);
    }
  };

  useEffect(() => () => {
    if (prepTimerRef.current !== null) window.clearTimeout(prepTimerRef.current);
    systemPlayerRef.current?.close();
  }, []);

  /**
   * Renders one authoritative Follow event from the engine service. The
   * browser does not advance a cursor, match pitches or compute timing.
   */
  const handleFollowEvent = useCallback((message: FollowEventMessage) => {
    if (configRef.current.advanceMode !== 'follow') return;
    if (followStatusRef.current !== 'running') return;
    const result = message.result;
    const currentIndex = Number.isInteger(message.progress?.index)
      ? message.progress.index
      : result.progressIndex ?? 0;
    const total = Number.isInteger(message.progress?.total)
      ? message.progress.total
      : result.progressTotal ?? 0;
    const completed = Number.isInteger(message.progress?.completed)
      ? message.progress.completed
      : result.completedCount ?? 0;
    setFollowView({
      index: currentIndex,
      total,
      completed,
      currentGroup: followGroupsRef.current[currentIndex] ?? null,
      last: result,
    });
    if (result.kind === 'wrong') {
      setPitchMismatch(true);
      addFeedback('音高不正确，光标等待', `目标是 ${result.expectedPitches.join(' / ')}，你按的是 ${noteForMidi(message.note)}。光标会停在当前音，重新按对即可。`, 'warning');
    } else if (result.kind === 'partial') {
      addFeedback('和弦还差音', `还差 ${result.remainingPitches.join(' / ')}；补齐后光标才会前进。`, 'neutral');
    } else if (result.kind === 'duplicate') {
      addFeedback('重复按键', '这个音已经在当前目标里了；等光标前进后再弹下一个目标。', 'neutral');
    } else if (result.kind === 'correct' || result.kind === 'complete') {
      setPitchMismatch(false);
      setFollowPulse((value) => value + 1);
      markUserNotes(planGroupsRef.current[Math.max(0, currentIndex - 1)]);
      const standard = result.completedTarget?.standard;
      if (standard === false) {
        addFeedback('已推进，但有偏差', '音高已对上；节奏或和弦间距超出当前档位容差，结果已记录。', 'warning');
      }
    } else if (result.kind === 'extra') {
      addFeedback('目标已完成后的输入', '光标已经到结尾；这次输入只记录为额外音符。', 'neutral');
    }
  }, [addFeedback, markUserNotes]);

  /** The service has committed the Follow Take (or finalized it interrupted). */
  const handleFollowReport = useCallback((message: FollowReportMessage) => {
    if (configRef.current.advanceMode !== 'follow') return;
    if (followStatusRef.current === 'idle' || followStatusRef.current === 'completed') return;
    const report = message.report;
    followStatusRef.current = 'completed';
    setFollowStatus('completed');
    setFollowReport(report);
    setFollowPersistence({
      takeId: message.takeId,
      persisted: message.persisted,
      status: message.persistenceStatus ?? (message.persisted ? 'persisted' : 'pending-retry'),
      error: message.persistenceError,
    });
    setFollowView((prev) => prev ? {
      ...prev,
      index: report.completedTargets,
      total: report.totalTargets,
      completed: report.completedTargets,
      currentGroup: followGroupsRef.current[report.completedTargets] ?? null,
    } : prev);
    const interrupted = message.endReason === 'interrupted';
    const saved = message.persisted;
    const summary = `标准 ${report.standardTargets} / 完成 ${report.completedTargets} / 目标 ${report.totalTargets}；错误音 ${report.wrongNoteCount}，额外音 ${report.extraNoteCount}。`;
    const persistenceNote = saved
      ? '已保存为一个 Follow Take。'
      : `保存失败：${message.persistenceError ?? '未知错误'}。本轮结果已固定但尚未写入历史，可重试保存。`;
    addFeedback(
      interrupted ? '跟手练习已中断' : saved ? '跟手练习完成' : '跟手练习已结束，但结果未保存',
      `${summary}${interrupted ? '本轮记为不可信 Take。' : ''}${persistenceNote}跟手模式不使用固定时间 strict 评分。`,
      interrupted || !saved ? 'warning' : 'success',
    );
    if (saved) setHistoryRefresh((value) => value + 1);
    setTeachingTakeNotice({
      takeId: message.takeId,
      persisted: saved,
      status: message.persistenceStatus ?? (saved ? 'persisted' : 'pending-retry'),
      fingerprint: sessionScoreFingerprintRef.current,
    });
  }, [addFeedback]);

  const session = usePracticeSession({
    onJudgment: (judgment) => {
      if (judgment.grade === 'perfect' || judgment.grade === 'good') {
        setFollowPulse((value) => value + 1);
        markUserNotes(judgment.targetIndex !== null ? planGroupsRef.current[judgment.targetIndex] : undefined);
      }
      if (config.feedback === 'live') {
        if (judgment.grade === 'miss') {
          addFeedback('漏掉目标', `第 ${(judgment.targetIndex ?? 0) + 1} 个目标没有被击中,节拍器会继续,跟上下一拍即可。`, 'warning');
        } else if (judgment.grade === 'extra') {
          const now = performance.now();
          if (now - lastExtraFeedbackRef.current > 1200) {
            lastExtraFeedbackRef.current = now;
            addFeedback('多余击打', '这次输入不在任何目标窗口内。等目标高亮再落键,避免抢拍。', 'neutral');
          }
        }
      }
    },
    onError: (message) => {
      setStarting(false);
      addFeedback('引擎提示', message, 'warning');
    },
    onStarted: (info) => {
      const plan = pendingReferencePlanRef.current;
      const controller = referencePlaybackRef.current;
      if (!plan || !controller || !systemDuetRef.current) return;
      controller.setGain(systemAudioRef.current ? 1 : 0);
      void controller.start(plan, {
        startAtMs: 0,
        originPerfMs: info.originPerfMs,
        engineTargets: info.targets,
      }).catch((error) => {
        addFeedback(
          '参考播放启动失败',
          error instanceof Error ? error.message : String(error),
          'warning',
        );
      });
    },
    // The server's Rust FollowRuntime is the only source of Follow events.
    onFollowEvent: handleFollowEvent,
    onFollowReport: handleFollowReport,
    onFollowAborted: (message) => {
      addFeedback('跟手练习已中断', message, 'warning');
      clearFollowSession();
    },
    // R2-3h-R1: the authority cache belonged to the connection that closed.
    onEngineDisconnected: () => {
      plannerAuthoritySeqRef.current += 1; // invalidate in-flight probes
      plannerAuthorityRef.current = null;
    },
  });

  useEffect(() => {
    let alive = true;
    const controller = new ReferencePlaybackController({
      audio: new WebAudioEngineAdapter(),
      onAudioSuspended: () => pauseSessionForAudioRef.current(),
      onDiagnostic: (diagnostic: PlaybackDiagnostic) => {
        if (!alive || diagnostic.severity === 'info') return;
        addFeedback(
          diagnostic.severity === 'error' ? '参考播放失败' : '参考播放降级',
          diagnostic.message,
          'warning',
        );
      },
    });
    referencePlaybackRef.current = controller;
    const unsubscribe = controller.subscribe((snapshot) => {
      if (alive) setReferenceSnapshot(snapshot);
    });
    return () => {
      alive = false;
      unsubscribe();
      controller.dispose();
      if (referencePlaybackRef.current === controller) referencePlaybackRef.current = null;
    };
  }, [addFeedback]);

  const handleTimelineRetrySave = useCallback(async () => {
    if (!session.takeId) return;
    try {
      const result = await session.retryPersist(session.takeId);
      if (result.persisted) {
        addFeedback('报告已保存', '本次 Take 已写入本地历史。', 'success');
        setHistoryRefresh((value) => value + 1);
      } else {
        addFeedback('仍未保存', result.persistenceError ?? '持久化仍然失败。', 'warning');
      }
    } catch (error) {
      addFeedback('重试保存失败', error instanceof Error ? error.message : String(error), 'warning');
    }
  }, [session.takeId, session.retryPersist, addFeedback]);

  const handleFollowRetrySave = useCallback(async () => {
    if (!followPersistence || followPersistence.persisted) return;
    setFollowRetrying(true);
    try {
      const result = await session.retryPersist(followPersistence.takeId);
      setFollowPersistence({
        takeId: result.takeId,
        persisted: result.persisted,
        status: result.persistenceStatus,
        error: result.persistenceError,
      });
      if (result.persisted) {
        addFeedback('跟手结果已保存', '这次 Follow Take 已写入本地历史。', 'success');
        setHistoryRefresh((value) => value + 1);
      } else {
        addFeedback('仍未保存', result.persistenceError ?? '持久化仍然失败。', 'warning');
      }
    } catch (error) {
      addFeedback('重试保存失败', error instanceof Error ? error.message : String(error), 'warning');
    } finally {
      setFollowRetrying(false);
    }
  }, [followPersistence, session.retryPersist, addFeedback]);

  const reportUnsaved = (session.status === 'completed' && session.reportPersisted === false)
    || (followPersistence !== null && !followPersistence.persisted);
  const practiceInProgress = prepRemain !== null
    || starting
    || session.active
    || followStatus === 'running'
    || followStatus === 'paused';

  const requestNavigation = (targetPath: string) => {
    if (targetPath === routePath) return;
    if (reportUnsaved) {
      addFeedback('报告未保存，不能离开', '本轮报告已生成但持久化失败；请先查看错误并处理数据目录，暂不导航。', 'warning');
      return;
    }
    if (!practiceInProgress) {
      navigate(targetPath);
      return;
    }
    setLeaveError(null);
    setLeaveRequest((prev) => prev ?? { targetPath });
  };

  routeGuardRef.current = (nextPath) => {
    if (nextPath === routePath) return true;
    if (reportUnsaved) return false;
    if (!practiceInProgress) return true;
    setLeaveError(null);
    setLeaveRequest((prev) => prev ?? { targetPath: nextPath });
    return false;
  };

  const configRef = useRef(config);
  configRef.current = config;
  const noteNamesVisibleRef = useRef(scoreHints.noteNames);
  noteNamesVisibleRef.current = scoreHints.noteNames;

  // Hint toggles are display-only preferences; they never enter the engine
  // payload or PracticeConfig. Strict judgment hides note names by default.
  useEffect(() => {
    saveScoreHintOverrides(hintOverrides);
  }, [hintOverrides]);

  const toggleNoteNames = () => {
    setHintOverrides((prev) => ({
      ...prev,
      noteNames: !resolveScoreHints(prev, configRef.current.profile).noteNames,
    }));
  };

  const togglePositionHints = () => {
    setHintOverrides((prev) => ({
      ...prev,
      positionHints: !resolveScoreHints(prev, configRef.current.profile).positionHints,
    }));
  };

  const clearFollowSession = () => {
    // Invalidate any in-flight follow-start acknowledgement, then let the
    // service commit an interrupted Take (no-op when nothing is live).
    followStartSeqRef.current += 1;
    followGroupsRef.current = [];
    session.abandonFollow();
    followStatusRef.current = 'idle';
    setFollowStatus('idle');
    setFollowReport(null);
    setFollowPersistence(null);
    setFollowView(null);
  };

  /**
   * Starts the server-authoritative Follow runtime. The projection/context is
   * sent with the request; the server validates it, owns progression and
   * commits exactly one Follow Take. UI state changes only after the
   * service confirms the start.
   */
  const beginServerFollow = (args: {
    groups: readonly PlaybackGroup[];
    bpm: number;
    planRequestId?: string;
    scoreFingerprint: string | null;
    plannerAuthority: 'rts' | 'rust';
    plannerVersion?: string | null;
    planFingerprint?: string | null;
    scoreId?: string | null;
    configSnapshot: Record<string, unknown>;
    modeId: string;
    timingToleranceMs: number;
    statusLabel: string;
  }) => {
    const seq = ++followStartSeqRef.current;
    const origin = performance.now();
    displayStartRef.current = origin;
    elapsedBeforePauseRef.current = 0;
    followGroupsRef.current = args.groups;
    expectedNotesRef.current = args.groups.map((group) => group.pitches.map((pitch) => ({
      midiNote: pitch.midiNote ?? 0,
      noteName: pitch.spelling,
    })));
    planGroupsRef.current = args.groups.map((group) => [...group.scoreEventIds]);
    setFollowView({
      index: 0,
      total: args.groups.length,
      completed: 0,
      currentGroup: args.groups[0] ?? null,
      last: null,
    });
    setFollowReport(null);
    setFollowPersistence(null);
    setEvents([]); setInputNote('—'); setPitchMismatch(false); setElapsed(0);
    followStatusRef.current = 'idle';
    setFollowStatus('idle');
    void session.startFollow({
      ...(args.planRequestId
        ? { planRequestId: args.planRequestId }
        : { groups: toFollowGroupRequests(args.groups) }),
      bpm: args.bpm,
      plannerAuthority: args.plannerAuthority,
      plannerVersion: args.plannerVersion ?? null,
      planFingerprint: args.planFingerprint ?? null,
      scoreFingerprint: args.scoreFingerprint,
      scoreId: args.scoreId ?? null,
      configSnapshot: args.configSnapshot,
      startedAtIso: new Date().toISOString(),
      basePerfMs: origin,
      modeId: args.modeId,
      timingToleranceMs: args.timingToleranceMs,
      chordSpreadToleranceMs: 50,
    }).then((started) => {
      if (seq !== followStartSeqRef.current) {
        session.abandonFollow();
        return;
      }
      if (configRef.current.advanceMode !== 'follow') {
        session.abandonFollow();
        return;
      }
      const index = Number.isInteger(started.progress?.index) ? started.progress.index : 0;
      followStatusRef.current = 'running';
      setFollowStatus('running');
      setFollowView((prev) => prev ? {
        index,
        total: started.progress?.total ?? args.groups.length,
        completed: started.progress?.completed ?? 0,
        currentGroup: args.groups[index] ?? null,
        last: null,
      } : prev);
      addFeedback(
        `${args.statusLabel}已开始`,
        `${args.groups.length} 个起音目标；光标只在弹对当前目标后前进。结果由引擎结算为一个 Follow Take，不是固定时间 strict 成绩。`,
        'neutral',
      );
      setStarting(false);
    }).catch((error) => {
      if (seq !== followStartSeqRef.current) return;
      clearFollowSession();
      setStarting(false);
      addFeedback('无法开始跟手练习', error instanceof Error ? error.message : String(error), 'warning');
    });
    return true;
  };

  /** User-paced green cursor while the system duet plays on the fixed clock. */
  const handleGuideNote = useCallback((midiNote: number) => {
    const guide = guideSessionRef.current;
    if (!guide) return;
    const targetIds = guide.currentGroup ? [...guide.currentGroup.scoreEventIds] : [];
    const atMs = displayStartRef.current !== null ? performance.now() - displayStartRef.current : 0;
    const result = guide.handleNoteOn(midiNote, atMs);
    setGuideView({ index: guide.progress.index, currentGroup: guide.currentGroup, completed: guide.completedCount });
    if (result.advanced) {
      setFollowPulse((value) => value + 1);
      markUserNotes(targetIds);
    }
    if (result.kind === 'wrong') {
      setPitchMismatch(true);
      addFeedback('系统伴弹：音高不对', `目标是 ${result.expectedPitches.join(' / ')}；绿色光标会停在当前目标，重新按对即可。`, 'warning');
    } else {
      setPitchMismatch(false);
    }
  }, [addFeedback, markUserNotes]);

  /** Builds a mock RawMidiPacket — the virtual keyboard MUST go through the
   *  same raw-packet pipeline as hardware (v0.6: no injected scored hits). */
  const buildMockPacket = (noteOn: boolean, note: number): EngineRawMidiPacket => {
    mockSeqRef.current += 1;
    const captureEpoch = session.getCaptureEpoch();
    return {
      sourceId: 'virtual-keys',
      sourceSeq: mockSeqRef.current,
      clockDomainId: 'web-page-performance-timeline',
      capturedAtMs: performance.now(),
      rawBytes: noteOn ? [0x90, note, 92] : [0x80, note, 64],
      transport: 'mock',
      ...(captureEpoch != null ? { captureEpoch } : {}),
    };
  };

  /** v0.6: the only input path — raw packets in, engine outputs out.
   *  Note identity below is a UI view model derived from packet bytes. */
  const handleRawPacket = useCallback((packet: EngineRawMidiPacket) => {
    const command = packet.rawBytes[0] & 0xf0;
    // The SP-A500 streams MIDI Clock (0xF8) and Active Sensing (0xFE)
    // continuously; they are audit-log material, never key presses.
    if (command !== 0x80 && command !== 0x90) return;
    const midiNote = packet.rawBytes[1] ?? 0;
    const isRelease = command === 0x80 || (command === 0x90 && packet.rawBytes[2] === 0);
    setLastInputMidi(midiNote);
    setEvents(prev => [...prev, {
      type: isRelease ? 'note-off' : 'note-on',
      midiNote,
      velocity: packet.rawBytes[2] ?? 0,
      timestampMs: packet.capturedAtMs,
      source: packet.transport === 'web-midi' ? 'device' : 'simulator',
      channel: packet.rawBytes[0] & 0x0f,
      sourceId: packet.sourceId,
    } as MidiPerformanceEvent]);
    setInputNote(noteForMidi(midiNote));
    setPitchMismatch(false);
    if (configRef.current.modeId === 'free') return;
    if (configRef.current.advanceMode === 'follow') {
      if (!isRelease && followStatusRef.current === 'running') {
        const atMs = displayStartRef.current !== null ? performance.now() - displayStartRef.current : 0;
        session.sendFollowNote(midiNote, atMs);
      }
      return;
    }
    if (!isRelease && configRef.current.advanceMode === 'timeline') {
      handleGuideNote(midiNote);
    }
    // BOTH Note On and Note Off packets must reach the engine — durations are
    // paired server-side from the raw packets (a dropped Off = unknowable).
    const atMs = session.ingestPacket(packet);
    if (atMs === null || isRelease) return;
    // Pitch hint is gated by the EFFECTIVE take config (mode policy), not by
    // the raw mode id: rhythm/free declare pitchHint=false, so no hint fires.
    if (session.scoringConfig?.pitchHint && configRef.current.feedback === 'live') {
      const expectedGroup = expectedNotesRef.current[Math.min(session.nextUnmatchedIndex, Math.max(expectedNotesRef.current.length - 1, 0))];
      const expected = expectedGroup?.find(note => note.midiNote === midiNote);
      if (expectedGroup && expectedGroup.length > 0 && !expected) {
        setPitchMismatch(true);
        const names = expectedGroup.map(note => note.noteName).join(' / ');
        const targetText = noteNamesVisibleRef.current ? `目标音是 ${names},` : '目标音与输入不一致;';
        addFeedback('音高提示', `${targetText}你按的是 ${noteForMidi(midiNote)}。音高不计入节奏评分,但会影响音乐效果。`, 'warning');
      }
    }
  }, [addFeedback, handleGuideNote, session]);


  // Re-render the countdown readout while counting in.
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    if (session.status !== 'countdown') return;
    const timer = window.setInterval(() => setNowTick(performance.now()), 200);
    return () => window.clearInterval(timer);
  }, [session.status]);

  // R2-3h: resolve the server-side planner authority once per connection. A
  // failure leaves it unknown (never assumed 'rts' — an unknown state at
  // launch time re-probes and refuses to plan with TS if it cannot confirm).
  // R2-3h-R1: answers carry a generation so an older (slower) probe can never
  // overwrite a newer result, and a socket disconnect invalidates the cache.
  const refreshPlannerAuthority = async (): Promise<'rts' | 'rust' | null> => {
    const seq = ++plannerAuthoritySeqRef.current;
    try {
      const status = await session.getPlannerStatus();
      if (seq !== plannerAuthoritySeqRef.current) return plannerAuthorityRef.current;
      const authority = status.authority;
      if (authority !== 'rts' && authority !== 'rust') {
        plannerAuthorityRef.current = null;
        return null;
      }
      plannerAuthorityRef.current = authority;
      return authority;
    } catch {
      if (seq !== plannerAuthoritySeqRef.current) return plannerAuthorityRef.current;
      plannerAuthorityRef.current = null;
      return null;
    }
  };

  useEffect(() => {
    void refreshPlannerAuthority();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.getPlannerStatus]);

  // A finished report is persisted by the engine service — refresh history/profile data.
  useEffect(() => {
    if (session.report) {
      setHistoryRefresh((k) => k + 1);
      addFeedback('报告已保存', `本次练习已存入本机练习记录${session.sessionId ? `(${session.sessionId})` : ''},可在左侧「练习记录」查看。`, 'success');
      const mapping = session.captureDiagnostics?.clockMapping;
      if (mapping && mapping.status !== 'ok') {
        addFeedback(
          mapping.status === 'unscorable' ? '时钟映射不可信' : '时钟映射精度受限',
          mapping.reason,
          'warning',
        );
      }
    }
    // Offer the finished Take to the teaching workspace (persisted or not, so
    // the workspace can explain a pending-retry instead of silently moving on).
    if (session.takeId) {
      setTeachingTakeNotice({
        takeId: session.takeId,
        persisted: session.reportPersisted !== false,
        status: session.reportPersisted === false ? 'pending-retry' : 'persisted',
        fingerprint: session.scoreFingerprint ?? sessionScoreFingerprintRef.current,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.report]);

  const currentMode = modeRegistry[config.modeId];
  useEffect(() => {
    const title = route?.id === 'workbench' ? currentMode.title : route?.title ?? '页面不存在';
    document.title = `${title} · Rhythm Trainer`;
  }, [currentMode.title, route?.id, route?.title]);
  const maxBar = useMemo(
    () => Math.max(1, scoreDoc.meta.barCount, ...scoreDoc.notes.map((note) => note.bar)),
    [scoreDoc],
  );
  selectedPortIdRef.current = selectedPortId;
  sessionIndexRef.current = session.nextUnmatchedIndex;
  const visibleTargetNotes = useMemo(() => {
    if (config.modeId === 'free') return [];
    let notes = scoreDoc.notes.filter(note => config.hand === 'both' || note.hand === config.hand);
    if (config.modeId === 'score' && config.loopEnabled) {
      notes = notes.filter(note => note.bar >= config.loopStartBar && note.bar <= config.loopEndBar);
    }
    return notes;
  }, [config.hand, config.modeId, config.loopEnabled, config.loopStartBar, config.loopEndBar, scoreDoc.notes]);
  const scopedTargetCount = useMemo(
    () => new Set(visibleTargetNotes.map((note) => note.beat)).size,
    [visibleTargetNotes],
  );
  const engineTargets = session.targets.length > 0;
  const followGroup = config.advanceMode === 'follow' ? followView?.currentGroup ?? null : null;
  // Score highlight follows the engine's target groups (chords share one target).
  // In follow mode it follows the waiting FollowSession cursor instead.
  const guideGroup = config.advanceMode === 'timeline' ? guideView?.currentGroup ?? null : null;
  const engineActiveNoteIds = config.advanceMode === 'follow'
    ? (followGroup ? [...followGroup.scoreEventIds] : [])
    : planGroupsRef.current.length && (session.active || session.report)
      ? planGroupsRef.current[Math.min(session.nextUnmatchedIndex, planGroupsRef.current.length - 1)] ?? []
      : (() => {
          if (!visibleTargetNotes.length) return [];
          const firstBeat = Math.min(...visibleTargetNotes.map((note) => note.beat));
          return visibleTargetNotes.filter((note) => note.beat === firstBeat).map((note) => note.id);
        })();
  // With the system duet, the green cursor is user-paced (FollowSession guide)
  // and does not advance when the fixed clock advances or a miss occurs.
  const activeNoteIds = guideGroup ? [...guideGroup.scoreEventIds] : engineActiveNoteIds;
  const activeNoteKey = activeNoteIds.join('|');
  const noteMidiById = useMemo(
    () => new Map(scoreDoc.notes.map((note) => [note.id, note.midiNote])),
    [scoreDoc.notes],
  );

  // Follow mode: the system plays the current target once as a guide; when the
  // player advances it, the next target is played. Red = system's notes.
  useEffect(() => {
    if (!systemDuet || !systemAudio || config.advanceMode !== 'follow' || followStatus !== 'running' || activeNoteIds.length === 0) return;
    const notes = activeNoteIds
      .map((id) => noteMidiById.get(id))
      .filter((midi): midi is number => typeof midi === 'number');
    if (!notes.length) return;
    systemPlayerRef.current ??= new SystemDuetPlayer();
    systemPlayerRef.current.playNow(notes, 600);
    markSystemNotes(activeNoteIds);
    // activeNoteKey stands in for the array identity; the effect must run once per target group.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNoteKey, systemDuet, systemAudio, config.advanceMode, followStatus, noteMidiById, markSystemNotes]);

  // System duet needs a fixed clock; follow mode cannot play the score ahead.
  useEffect(() => {
    if (!systemDuet || config.advanceMode === 'timeline') return;
    setConfig((prev) => prev.advanceMode === 'timeline' ? prev : { ...prev, advanceMode: 'timeline' });
    setSettingsDraft((prev) => prev ? { ...prev, config: { ...prev.config, advanceMode: 'timeline' } } : prev);
  }, [systemDuet, config.advanceMode]);

  // Reference playback owns the timeline. Red marks are sampled from its
  // snapshot, so pause/resume and UI throttling do not reschedule audio.
  useEffect(() => {
    const plan = referencePlanRef.current;
    if (!systemDuet || !plan || !referenceSnapshot) return;
    const position = referenceSnapshot.positionMs;
    while (referenceMarkedIndexRef.current < plan.notes.length) {
      const note = plan.notes[referenceMarkedIndexRef.current];
      if (note.atMs > position + 1) break;
      markSystemNotes(note.activeScoreEventIds);
      referenceMarkedIndexRef.current += 1;
    }
  }, [referenceSnapshot, systemDuet, markSystemNotes]);

  useEffect(() => {
    if (session.status === 'paused' || session.status === 'completed' || session.status === 'idle') {
      systemPlayerRef.current?.stopAll();
      clearDuetTimers();
    }
    if ((session.status === 'idle' || session.status === 'completed') && referencePlaybackRef.current?.active) {
      referencePlaybackRef.current.stop(`session-${session.status}`);
    }
  }, [session.status]);

  const currentTargetLabel = guideGroup
    ? guideGroup.pitches.map((pitch) => pitch.spelling).join(' / ')
    : config.advanceMode === 'follow'
    ? (followGroup
        ? followGroup.pitches.map((pitch) => pitch.spelling).join(' / ')
        : followStatus === 'completed' ? '已完成' : '—')
    : config.modeId === 'free' ? '自由演奏'
    : config.modeId === 'rhythm' ? '跟随拍点'
    : !scoreHints.noteNames ? '跟随高亮'
    : (() => {
        if (planGroupsRef.current.length) {
          const index = Math.min(session.nextUnmatchedIndex, planGroupsRef.current.length - 1);
          const names = expectedNotesRef.current[index]?.map(note => note.noteName).join(' / ');
          if (names) return names;
        }
        if (!visibleTargetNotes.length) return '—';
        const firstBeat = Math.min(...visibleTargetNotes.map((note) => note.beat));
        return visibleTargetNotes
          .filter((note) => note.beat === firstBeat)
          .map((note) => note.noteName)
          .join(' / ');
      })();

  const handleServerMidiEvent = useCallback((event: MidiInputEvent) => {
    setNodeEvents((prev) => [event, ...prev].slice(0, 8));
    if (event.messageType === 'note-on' || event.messageType === 'note-off') {
      const noteNumber = event.noteNumber ?? 0;
      setHeldDeviceNotes((prev) => {
        if (event.messageType === 'note-off') {
          return prev.filter((note) => !(note.noteNumber === noteNumber && note.channel === event.channel));
        }
        if (prev.some((note) => note.noteNumber === noteNumber && note.channel === event.channel)) return prev;
        return [...prev, {
          noteNumber,
          since: performance.now(),
          velocity: event.velocity,
          channel: event.channel,
        }];
      });
    }
    if (event.messageType !== 'note-on' && event.messageType !== 'note-off') return;
    const midiNote = event.noteNumber ?? 0;
    setLastInputMidi(midiNote);
    setEvents((prev) => [...prev, {
      type: event.messageType === 'note-on' ? 'note-on' : 'note-off',
      midiNote,
      velocity: event.velocity ?? 0,
      timestampMs: event.capturedAtMonotonicMs,
      source: 'device',
      channel: event.channel,
      sourceId: event.sourceId,
    } as MidiPerformanceEvent]);
    setInputNote(noteForMidi(midiNote));
    if (event.messageType !== 'note-on') return;
    setPitchMismatch(false);
    if (configRef.current.advanceMode === 'follow') {
      // The engine service routes hardware Note On straight into the Rust
      // FollowRuntime and returns a follow-event. Sending follow-note here
      // would count the same key twice.
      return;
    }
    // Node MIDI is ingested server-side for scoring; the browser-side guide
    // cursor still needs the same Note On so hardware input advances it.
    if (configRef.current.advanceMode === 'timeline') {
      handleGuideNote(midiNote);
    }
    if (configRef.current.modeId !== 'rhythm' && configRef.current.modeId !== 'free' && configRef.current.feedback === 'live') {
      const expected = expectedNotesRef.current[Math.min(sessionIndexRef.current, Math.max(expectedNotesRef.current.length - 1, 0))];
      if (expected && expected.length > 0 && !expected.some((note) => note.midiNote === midiNote)) {
        setPitchMismatch(true);
        const targetText = noteNamesVisibleRef.current
          ? `目标音是 ${expected.map((note) => note.noteName).join(' / ')}，`
          : '目标音与输入不一致；';
        addFeedback('音高提示', `${targetText}你按的是 ${noteForMidi(midiNote)}。音高不计入节奏评分，但会影响音乐效果。`, 'warning');
      }
    }
  }, [addFeedback, handleGuideNote]);

  const handleDeviceStatus = useCallback((status: MidiAdapterStatus) => {
    setDeviceHealth(status.inputHealth);
    setDeviceError(status.lastError);
    setIsConnecting(false);
    if (!status.connected) setHeldDeviceNotes([]);
    if (status.connected) {
      setDeviceStatus('connected');
      setDeviceName(status.device?.name ?? 'MIDI 输入');
    } else {
      setDeviceStatus(status.lastError ? 'error' : 'disconnected');
      setDeviceName(status.device?.name ?? '尚未连接');
    }
  }, []);

  const handleDeviceList = useCallback((items: MidiDeviceInfo[]) => {
    setPortOptions(items);
    setSelectedPortId((prev) => (prev && items.some((item) => item.id === prev) ? prev : items[0]?.id ?? null));
  }, []);

  useEffect(() => {
    const bridge = new DeviceBridge({
      onDevices: handleDeviceList,
      onStatus: handleDeviceStatus,
      onEvent: handleServerMidiEvent,
      onError: (error) => {
        setIsConnecting(false);
        setDeviceStatus('error');
        setDeviceError(error.code);
        addFeedback('MIDI 设备错误', `${error.message}（${error.code}）`, 'warning');
      },
      onDiagnostic: (diagnostic) => {
        addFeedback('MIDI 诊断', `${diagnostic.message}（${diagnostic.code}）`, diagnostic.severity === 'error' ? 'warning' : 'neutral');
      },
    });
    deviceBridgeRef.current = bridge;
    return () => {
      bridge.close();
      deviceBridgeRef.current = null;
    };
  }, [addFeedback, handleDeviceList, handleDeviceStatus, handleServerMidiEvent]);

  const connectDevice = (portId?: string) => {
    const chosen = portId ?? selectedPortIdRef.current ?? portOptions[0]?.id ?? null;
    if (!chosen) {
      setDeviceStatus('error');
      setDeviceError('MIDI_INPUT_OPEN_FAILED');
      addFeedback('没有可用的 MIDI 设备', '请确认电钢琴使用 USB TO HOST 数据线连接并开机，然后刷新设备列表。', 'warning');
      return;
    }
    setSelectedPortId(chosen);
    setNodeEvents([]);
    setHeldDeviceNotes([]);
    setIsConnecting(true);
    setDeviceStatus('connecting');
    setDeviceError(null);
    deviceBridgeRef.current?.connect(chosen);
    addFeedback('正在连接 MIDI 设备', '等待 Node MIDI Adapter 打开端口…', 'neutral');
  };

  const refreshDevices = () => {
    setIsConnecting(true);
    deviceBridgeRef.current?.refresh();
  };

  const exportMidiLog = async () => {
    try {
      const endpoint = session.traceId
        ? `/api/traces/${encodeURIComponent(session.traceId)}`
        : '/api/midi/trace';
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const trace = await response.json();
      const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = session.traceId
        ? `${session.traceId}.json`
        : `node-midi-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      link.click();
      URL.revokeObjectURL(url);
      const eventCount = Number(trace.eventCount ?? trace.manifest?.eventCount ?? 0);
      const dropped = Number(trace.dropped ?? trace.manifest?.dropped ?? 0) + Number(trace.queueDropped ?? 0);
      addFeedback(
        '日志已导出',
        `${session.traceId ? '已保存的 Take Trace' : '当前 Node MIDI Trace'}：${eventCount} 条事件${dropped ? `（丢弃 ${dropped} 条）` : ''}，含原始字节与 sourceSeq。`,
        dropped ? 'warning' : 'success',
      );
    } catch (error) {
      addFeedback('导出失败', `无法读取 MIDI Trace：${error instanceof Error ? error.message : String(error)}`, 'warning');
    }
  };

  const disconnectDevice = () => {
    deviceBridgeRef.current?.disconnect();
    setNodeEvents([]);
    setHeldDeviceNotes([]);
    setIsConnecting(false);
    addFeedback('正在断开 MIDI', '已请求 Node MIDI Adapter 释放端口。', 'neutral');
  };

  /**
   * R2-3h: the opt-in Rust launch path. The server owns the plan; this
   * function only parses the response, derives presentation times once
   * (us/1000) and hands the result to the existing session/FollowSession.
   * Any failure fails the launch closed — it NEVER falls back to the TS
   * planner (no TS planner call exists on this branch).
   */
  /** Provenance of a launch armed from a Node teaching step: the persisted
   * Take this attempt belongs to. Teaching decisions read these refs from the
   * saved Take; TS never attaches a prescription object to a launch. */
  type LaunchSource = {
    scoreFingerprint: string;
    sourceReportId: string;
    sourceTakeId: string;
    scoreBarCount: number;
  };

  const startRustPractice = async (
    mode: 'timeline' | 'follow',
    launchConfig: PracticeConfig,
    context: {
      engineMode: string;
      countInBeats: number;
      source?: LaunchSource;
      takeTemplateId: string | null;
      partId: string;
      range: { startMeasureOrdinal: number; endMeasureOrdinal: number };
      handMapping: HandMappingV1;
    },
  ) => {
    const engineDoc = scoreDoc.engine;
    const report = scoreDoc.importReport;
    // R2-3h-R1 (F2): bind this launch to a generation, the exact score/config
    // snapshot taken at request time AND the actual launch mode. A newer launch
    // supersedes it, a changed score/config changes the snapshot, and switching
    // Timeline <-> Follow is caught by the mode field — so a late response can
    // never start a session for state the user has already left.
    const generation = ++launchSeqRef.current;
    const boundFingerprint = engineDoc?.fingerprint ?? null;
    const boundContextKey = planContextKey({
      hand: launchConfig.hand,
      tempo: launchConfig.tempo,
      modeId: launchConfig.modeId,
      loopActive: launchConfig.modeId === 'score' && launchConfig.loopEnabled,
      loopStartBar: launchConfig.loopStartBar,
      loopEndBar: launchConfig.loopEndBar,
      range: context.range,
      handMapping: context.handMapping,
      repeatSelection: { kind: 'none' },
      countInUs: DEFAULT_COUNT_IN_MS * 1000,
      ticksPerQuarter: 960,
    });
    if (!engineDoc || !report || boundFingerprint === null) {
      setStarting(false);
      addFeedback(
        '无法从引擎获取严格计划',
        'DOCUMENT_UNAVAILABLE: 当前乐谱缺少语义引擎数据。本次练习不会启动。',
        'warning',
      );
      return;
    }

    const outcome = await orchestrateRustLaunch<true>({
      token: { generation, contextKey: boundContextKey, scoreFingerprint: boundFingerprint, mode },
      request: async () => {
        // Inputs come from the existing import/projection flow — never from a
        // reconstructed TS PlaybackPlan.
        const projected = projectScoreDocumentV1(engineDoc, report);
        if (projected.issues.length > 0) {
          throw new Error(`DOCUMENT_VALIDATION_FAILED: ${projected.issues.map((issue) => issue.code).join(', ')}`);
        }
        const planConfig = {
          partId: context.partId,
          range: context.range,
          repeatSelection: { kind: 'none' as const },
          hand: launchConfig.hand,
          handMapping: context.handMapping,
          bpm: { numerator: launchConfig.tempo, denominator: 1 },
          // The existing "three seconds of preparation" expressed in canonical µs.
          countInUs: 3_000_000,
          ticksPerQuarter: 960,
          unsupportedNotationPolicy: 'reject-strict' as const,
        };
        return session.requestPlannerPlan({
          document: projected.dto,
          report,
          config: planConfig,
          mode,
          scoreFingerprint: boundFingerprint,
          timeoutMs: 15000,
        });
      },
      // Read from the CURRENT app state (refs), not from the async closure: a
      // captured fingerprint cannot prove the score is still the selected one.
      live: () => {
        const currentConfig = configRef.current;
        const currentDoc = scoreDocRef.current;
        const currentLoop = currentConfig.modeId === 'score' && currentConfig.loopEnabled;
        const currentRange = {
          startMeasureOrdinal: currentLoop ? currentConfig.loopStartBar : 1,
          endMeasureOrdinal: currentLoop ? currentConfig.loopEndBar : currentDoc.meta.barCount,
        };
        const currentFingerprint = currentDoc.engine?.fingerprint ?? null;
        const currentPartId = currentDoc.engine?.parts[0]?.id ?? 'P1';
        return {
          generation: launchSeqRef.current,
          contextKey: planContextKey({
            hand: currentConfig.hand,
            tempo: currentConfig.tempo,
            modeId: currentConfig.modeId,
            loopActive: currentLoop,
            loopStartBar: currentConfig.loopStartBar,
            loopEndBar: currentConfig.loopEndBar,
            range: currentRange,
            handMapping: currentFingerprint
              ? userHandMappingFor(currentFingerprint, currentPartId)
              : null,
            repeatSelection: { kind: 'none' },
            countInUs: DEFAULT_COUNT_IN_MS * 1000,
            ticksPerQuarter: 960,
          }),
          scoreFingerprint: currentFingerprint,
          mode: currentConfig.advanceMode,
          authority: plannerAuthorityRef.current,
        };
      },
      accept: (response) => {
        const countInUs = DEFAULT_COUNT_IN_MS * 1000;
        // Response binding: same score, then the mode-specific gates.
        if (response.scoreFingerprint !== boundFingerprint) {
          throw new Error('PLAN_RESPONSE_MISMATCH: 计划对应的曲谱与当前曲谱不一致');
        }
        if (mode === 'timeline') assertTimelineResponseUsable(response);
        else assertFollowResponseUsable(response);
        const span = rangeSpanFromDocument(engineDoc.parts[0].measures, context.range);
        const parsed = toPlaybackPlan(response, {
          range: context.range,
          repeatSelection: { kind: 'none' },
          rangeStartBeat: span.rangeStartBeat,
          rangeDurationBeat: span.rangeDurationBeat,
        });
        // Stage 2: one validated bundle per launch. Atoms/scoreEvents are taken
        // from this bundle below, never regenerated from a second structure.
        const bundleConfig: BundleConfigInput = {
          modeId: launchConfig.modeId,
          advanceMode: mode,
          bpm: { numerator: launchConfig.tempo, denominator: 1 },
          range: context.range,
          repeatSelection: { kind: 'none' },
          hand: launchConfig.hand,
          handMapping: context.handMapping,
          countInUs,
          ticksPerQuarter: 960,
          unsupportedNotationPolicy: 'reject-strict',
          plannerVersion: response.plannerVersion,
        };
        const bundle = buildPracticePlanBundleFromRust({
          response,
          plan: parsed.plan,
          config: bundleConfig,
          fingerprint: { document: engineDoc, report, partId: context.partId },
        });
        assertPracticePlanBundle(bundle);
        // Presentation-only reference plan. The Rust plan is ALREADY hand
        // filtered, so the builder runs with hand='both' (its documented no-op)
        // — never a second hand filter.
        const reference = buildReferencePlaybackPlan(parsed.plan, {
          bpm: launchConfig.tempo,
          countInBeats: context.countInBeats,
          hand: 'both',
        });
        if (!reference.plan || !reference.strictAllowed) {
          throw new Error('REFERENCE_PLAN_REJECTED: 参考播放计划被阻断');
        }
        referencePlanRef.current = reference.plan;
        pendingReferencePlanRef.current = reference.plan;
        referenceMarkedIndexRef.current = 0;
        const expectedNotes = parsed.groups.map((group) => group.pitches.map((pitch) => ({
          midiNote: pitch.midiNote ?? 0,
          noteName: pitch.spelling,
        })));
        const groupNoteIds = parsed.groups.map((group) => [...group.scoreEventIds]);
        expectedNotesRef.current = expectedNotes;
        planGroupsRef.current = groupNoteIds;
        const toleranceMs = launchConfig.profile === 'strict' ? 30 : launchConfig.profile === 'relaxed' ? 100 : 60;

        if (mode === 'follow') {
          // Follow consumes groups/occurrences only and never calls
          // session.begin. The server issues the plan context and owns the
          // Rust FollowRuntime + Take finalization.
          beginServerFollow({
            groups: parsed.groups,
            bpm: launchConfig.tempo,
            planRequestId: response.requestId,
            scoreFingerprint: response.scoreFingerprint ?? boundFingerprint,
            plannerAuthority: 'rust',
            plannerVersion: response.plannerVersion,
            planFingerprint: response.planFingerprint,
            scoreId: activeLibraryId ?? null,
            configSnapshot: launchConfig as unknown as Record<string, unknown>,
            modeId: context.engineMode,
            timingToleranceMs: toleranceMs,
            statusLabel: '跟手等待模式（引擎计划）',
          });
          return true as const;
        }

        const atoms = engineAtomsFromBundle(bundle);
        const scoreEvents = engineScoreEventsFromBundle(bundle);
        const guideSession = new FollowSession(parsed.groups, launchConfig.tempo, {
          timingToleranceMs: toleranceMs,
          chordSpreadToleranceMs: 50,
        });
        guideSessionRef.current = guideSession;
        setGuideView({ index: 0, currentGroup: guideSession.currentGroup, completed: 0 });
        void session.begin({
          modeId: context.engineMode,
          bpm: launchConfig.tempo,
          profile: launchConfig.profile,
          countInBeats: context.countInBeats,
          countInUs,
          ticksPerQuarter: 960,
          metronomeEnabled: metronomeOn,
          beatsPerBar: (launchConfig.timeSignature[0] * 4) / launchConfig.timeSignature[1],
          atoms,
          scoreEvents,
          assisted: launchConfig.feedback === 'live',
          durationPolicy: launchConfig.durationPolicy,
          scoreFingerprint: engineDoc.fingerprint,
          playbackPlanId: response.plan.runtimeIds.planId,
          // The server binds this Take to the plan context it issued.
          planRequestId: response.requestId,
          scoreId: activeLibraryId ?? undefined,
          configSnapshot: launchConfig as unknown as Record<string, unknown>,
          // R2-3i: bind the persisted Take to the exact plan response.
          plannerAuthority: response.plannerAuthority,
          plannerVersion: response.plannerVersion,
          planFingerprint: response.planFingerprint,
          scoreImportStatus: report.status,
          hand: launchConfig.hand,
          scoreBarCount: context.source?.scoreBarCount ?? scoreDoc.meta.barCount,
          ...(context.source ? {
            sourceReportId: context.source.sourceReportId,
            sourceTakeId: context.source.sourceTakeId,
          } : {}),
          ...(context.takeTemplateId ? { takeTemplateId: context.takeTemplateId } : {}),
        });
        addFeedback(
          '练习已开始（引擎计划）',
          `${modeRegistry[launchConfig.modeId].title} · ${launchConfig.tempo} BPM · 计划 ${response.plannerVersion} · 指纹 ${response.planFingerprint.slice(0, 22)}…`,
          'neutral',
        );
        return true as const;
      },
    });

    if (outcome.status === 'started') return;
    // A superseded launch leaves the UI to the newer one; any other
    // cancellation on the CURRENT generation must visibly fail the launch.
    const stillLatest = generation === launchSeqRef.current;
    if (!stillLatest || (outcome.status === 'cancelled' && outcome.code === 'STALE_SUPERSEDED')) return;
    setStarting(false);
    addFeedback(
      '无法从引擎获取严格计划',
      `${outcome.code}: ${outcome.message}。本次练习不会启动，也不会回退到浏览器内规划。`,
      'warning',
    );
  };

  const launchPractice = (
    overrideConfig?: PracticeConfig,
    source?: LaunchSource,
    takeTemplateId: string | null = appliedTakeTemplateId,
  ) => {
    if (session.active || starting || followStatusRef.current === 'running' || followStatusRef.current === 'paused' || followStatusRef.current === 'processing') return false;
    const config = overrideConfig ?? configRef.current;
    if (source && !(config.modeId === 'loop' || (config.modeId === 'score' && config.loopEnabled))) return false;
    if (source && (!scoreDoc.engine || scoreDoc.engine.fingerprint !== source.scoreFingerprint)) {
      addFeedback('复练曲谱不一致', '当前打开曲谱与来源报告不一致，未创建复练任务。', 'warning');
      return false;
    }
    const loopActive = config.modeId === 'score' && config.loopEnabled;
    const engineMode = engineModeFor(config);
    // Three seconds of preparation, expressed in this tempo's beats so the
    // engine, score events, reference playback and metronome share one clock.
    const countInBeats = countInBeatsForTempo(config.tempo);
    const countInUs = DEFAULT_COUNT_IN_MS * 1000;
    if (overrideConfig) {
      setConfig(overrideConfig);
      setSettingsDraft(null);
      setShowSettings(false);
    }
    let handByScoreEventId: Map<string, 'left' | 'right'> = new Map();
    /** R2-3h: the explicit scope the planner request is built from. */
    let launchScope: { partId: string; range: { startMeasureOrdinal: number; endMeasureOrdinal: number }; handMapping: HandMappingV1 } | null = null;
    if (config.modeId !== 'free') {
      const report = scoreDoc.importReport;
      if (report && !report.strictAllowed) {
        const blocking = report.issues.filter((issue) => issue.blocksStrict).map((issue) => issue.message);
        addFeedback('该乐谱不能严格评分', `${blocking.slice(0, 3).join('；') || '导入报告标记为非严格就绪'}。可以浏览谱面，但不能开始严格计时练习。`, 'warning');
        return false;
      }
      // P1-4: hand/multi-part gate. The hand comes from an explicit user
      // mapping per score fingerprint; clef heuristics are never accepted for
      // strict practice. Multi-part scores are refused outright (option A of
      // the P1-4 review): until a Part selector exists there is no user-selected
      // partId, and parts[0] would silently leak other parts into hand='both'
      // plans, because filterPlaybackPlanByHand is a no-op for hand='both'.
      const engineFingerprint = scoreDoc.engine?.fingerprint ?? null;
      const partCount = scoreDoc.engine?.parts.length ?? 1;
      if (!engineFingerprint) {
        setStarting(false);
        addFeedback('无法确定练习范围', '当前乐谱缺少语义引擎数据，无法安全确定手别与练习范围。', 'warning');
        return false;
      }
      if (partCount > 1) {
        setStarting(false);
        addFeedback(
          '多 Part 乐谱暂不支持严格练习',
          `该乐谱包含 ${partCount} 个 Part；在提供显式 Part 选择之前，严格计分被禁止（避免把未选 Part 的音符混入目标）。可以浏览谱面。`,
          'warning',
        );
        return false;
      }
      const partId = scoreDoc.engine?.parts[0]?.id ?? 'P1';
      const storedMapping = userHandMappingFor(engineFingerprint, partId);
      if (!storedMapping) {
        setStarting(false);
        addFeedback(
          '需要先指定手别映射',
          '严格计分需要显式的谱表→手别映射；谱号推断只用于显示，不再作为默认。请在练习设置中确认手别后重试。',
          'warning',
        );
        return false;
      }
      const scopeRange = {
        startMeasureOrdinal: loopActive ? config.loopStartBar : 1,
        endMeasureOrdinal: loopActive ? config.loopEndBar : scoreDoc.meta.barCount,
      };
      const scopeForLaunch = {
        schemaVersion: 1 as const,
        partId,
        range: scopeRange,
        hand: config.hand as PracticeHand,
        handMapping: storedMapping,
      };
      const engineDoc = scoreDoc.engine!; // narrowed above via engineFingerprint
      const scopeAssessment = assessPracticeScope(engineDoc, scopeForLaunch);
      if (!scopeAssessment.ok) {
        setStarting(false);
        const codeText = scopeAssessment.codes.join('；');
        const missingText = scopeAssessment.missingStaffs
          .map((staff) => `part ${staff.partId} 谱表 ${staff.staffNumber}（${staff.eventCount} 个音）`)
          .join('；');
        addFeedback(
          '练习范围无法确定',
          `手别/Part 映射不满足严格计分要求（${codeText}）${missingText ? '：' + missingText : ''}。请在设置中完成手别映射。`,
          'warning',
        );
        return false;
      }
      handByScoreEventId = handByScoreEventIdFromMapping(engineDoc, scopeForLaunch);
      launchScope = { partId, range: scopeRange, handMapping: storedMapping };
      const launchNotes = scoreDoc.notes.filter((note) => (
        config.hand === 'both' || note.hand === config.hand
      )).filter((note) => (
        !loopActive || (note.bar >= config.loopStartBar && note.bar <= config.loopEndBar)
      ));
      const unsupported = getUnsupportedNotes(launchNotes, maxBar);
      if (unsupported.length > 0) {
        addFeedback(
          '谱面超出支持范围',
          `${unsupported.map(({ note, reason }) => `${reason}（第 ${note.bar} 小节）`).join('；')}。为避免绘制错误音符后继续判分，本次练习不会启动。`,
          'warning',
        );
        return false;
      }
    }
    if (deviceStatus !== 'connected') {
      addFeedback('未连接 MIDI 设备', '本次练习只能使用虚拟键盘/模拟按键；实体键盘输入不可用。设备检查页不会创建练习。', 'warning');
    } else if (deviceHealth !== 'healthy') {
      addFeedback('输入健康降级', `当前设备输入健康为 ${deviceHealth}；本轮结果可能降级，设备问题不会算成用户弹错。`, 'warning');
    }
    setStarting(true);
    elapsedBeforePauseRef.current = 0;
    displayStartRef.current = performance.now();
    setPitchMismatch(false);
    if (config.modeId === 'free') {
      session.beginFreePlay();
      addFeedback('自由弹奏开始', '只记录演奏事件,不做谱面评分。', 'neutral');
      return true;
    }
    if (config.advanceMode === 'follow') {
      if (!scoreDoc.engine) {
        setStarting(false);
        addFeedback('当前乐谱不能跟手练习', '跟手模式需要语义 MusicXML 谱面；请重新导入或恢复默认乐谱。', 'warning');
        return false;
      }
      // R2-3h-R1 (F1): the authority must be CONFIRMED. Unknown (null, a
      // failed probe or a disconnect) blocks the launch and re-probes — it
      // must never fall through to the TS planner.
      const authorityRoute = decideAuthority(plannerAuthorityRef.current);
      if (authorityRoute.route === 'blocked') {
        void refreshPlannerAuthority();
        setStarting(false);
        addFeedback(
          '无法确认规划权威',
          `${authorityRoute.message}（${authorityRoute.code}）请确认本地引擎服务已启动后重试。`,
          'warning',
        );
        return false;
      }
      // R2-3h: opt-in Rust authority. Follow asks for mode 'follow' and never
      // calls session.begin; failures fail the launch (no TS fallback).
      if (authorityRoute.route === 'rust' && launchScope) {
        void startRustPractice('follow', config, {
          engineMode,
          countInBeats,
          takeTemplateId,
          partId: launchScope.partId,
          range: launchScope.range,
          handMapping: launchScope.handMapping,
        });
        return true;
      }
      try {
        const semantics = buildPlaybackPlan(scoreDoc.engine, {
          range: {
            startMeasureOrdinal: loopActive ? config.loopStartBar : 1,
            endMeasureOrdinal: loopActive ? config.loopEndBar : scoreDoc.meta.barCount,
          },
          repeatSelection: { kind: 'none' },
          unsupportedNotationPolicy: 'reject-strict',
        });
        if (!semantics.plan || !semantics.strictAllowed) {
          setStarting(false);
          const blocking = semantics.issues.filter((issue) => issue.blocksStrict).map((issue) => issue.message);
          addFeedback('无法开始跟手练习', `${blocking.slice(0, 3).join('；') || 'PlaybackPlan 被阻断'}。请先处理乐谱导入提示。`, 'warning');
          return false;
        }
        // P1-4: the follow path uses the same explicit mapping (the gate above
        // already verified completeness); no clef inference here either.
        const scoped = filterPlaybackPlanByHand(semantics.plan, config.hand, handByScoreEventId);
        if (scoped.missingEventIds.length) {
          setStarting(false);
          addFeedback('无法确定练习手别', `有 ${scoped.missingEventIds.length} 个目标无法映射到左手/右手，已阻止开始。`, 'warning');
          return false;
        }
        if (!launchScope || !scoreDoc.importReport) {
          setStarting(false);
          addFeedback('无法确认练习范围', '缺少完整的手别映射或导入报告，已阻止开始。', 'warning');
          return false;
        }
        // Stage 2: Follow uses the same validated bundle as Timeline; only the
        // consumed projection differs (groups/occurrences, never strict atoms).
        const followBundle = buildPracticePlanBundleFromPlayback({
          plan: scoped.plan,
          config: {
            modeId: config.modeId,
            advanceMode: 'follow',
            bpm: { numerator: config.tempo, denominator: 1 },
            range: scoped.plan.range,
            repeatSelection: { kind: 'none' },
            hand: config.hand,
            handMapping: launchScope.handMapping,
            countInUs,
            ticksPerQuarter: 960,
            unsupportedNotationPolicy: 'reject-strict',
            plannerVersion: TS_PLANNER_VERSION,
          },
          fingerprint: {
            document: scoreDoc.engine,
            report: scoreDoc.importReport,
            partId: launchScope.partId,
          },
        });
        assertPracticePlanBundle(followBundle);
        const toleranceMs = config.profile === 'strict' ? 30 : config.profile === 'relaxed' ? 100 : 60;
        // Default rts path: the plan is still the TS projection, but the
        // authoritative Follow runtime and report are the server's Rust
        // implementation. The Take records the real provenance (rts plan +
        // client projection), never "rust plan".
        beginServerFollow({
          groups: scoped.plan.groups,
          bpm: config.tempo,
          scoreFingerprint: scoped.plan.scoreFingerprint ?? scoreDoc.engine?.fingerprint ?? null,
          plannerAuthority: 'rts',
          plannerVersion: TS_PLANNER_VERSION,
          planFingerprint: null,
          scoreId: activeLibraryId ?? null,
          configSnapshot: config as unknown as Record<string, unknown>,
          modeId: engineMode,
          timingToleranceMs: toleranceMs,
          statusLabel: '跟手等待模式',
        });
        return true;
      } catch (error) {
        setStarting(false);
        addFeedback('无法开始跟手练习', error instanceof Error ? error.message : String(error), 'warning');
        return false;
      }
    }
    clearFollowSession();
    // R2-3h-R1 (F1): the authority must be CONFIRMED before choosing a path.
    // Unknown blocks the launch and re-probes — never the TS planner.
    const timelineAuthorityRoute = decideAuthority(plannerAuthorityRef.current);
    if (timelineAuthorityRoute.route === 'blocked') {
      void refreshPlannerAuthority();
      setStarting(false);
      addFeedback(
        '无法确认规划权威',
        `${timelineAuthorityRoute.message}（${timelineAuthorityRoute.code}）请确认本地引擎服务已启动后重试。`,
        'warning',
      );
      return false;
    }
    // R2-3h: opt-in Rust authority for the timeline. The Rust plan is the only
    // plan generated on this branch (no TS planning, no fallback).
    if (timelineAuthorityRoute.route === 'rust' && scoreDoc.engine && launchScope) {
      void startRustPractice('timeline', config, {
        engineMode,
        countInBeats,
        source,
        takeTemplateId,
        partId: launchScope.partId,
        range: launchScope.range,
        handMapping: launchScope.handMapping,
      });
      return true;
    }
    let plan: ReturnType<typeof buildPracticePlan>;
    let playbackPlanId: string | null = null;
    let scoreEvents: ReturnType<typeof engineScoreEventsFromBundle> | undefined;
    let guideGroups: readonly PlaybackGroup[] | null = null;
    if (scoreDoc.engine) {
      try {
        const semantics = buildPlaybackPlan(scoreDoc.engine, {
          range: {
            startMeasureOrdinal: loopActive ? config.loopStartBar : 1,
            endMeasureOrdinal: loopActive ? config.loopEndBar : scoreDoc.meta.barCount,
          },
          repeatSelection: { kind: 'none' },
          unsupportedNotationPolicy: 'reject-strict',
        });
        if (!semantics.plan || !semantics.strictAllowed) {
          setStarting(false);
          const blocking = semantics.issues.filter((issue) => issue.blocksStrict).map((issue) => issue.message);
          addFeedback('无法生成严格目标', `${blocking.slice(0, 3).join('；') || 'PlaybackPlan 被阻断'}。请先处理乐谱导入提示。`, 'warning');
          return false;
        }
        // P1-4: reuse the explicit mapping from the scope gate above.
        const reference = buildReferencePlaybackPlan(semantics.plan, {
          bpm: config.tempo,
          countInBeats,
          hand: config.hand,
          handByScoreEventId,
        });
        if (!reference.plan || !reference.scopedPlan || !reference.strictAllowed) {
          setStarting(false);
          addFeedback(
            '无法生成参考播放计划',
            reference.issues.filter((issue) => issue.blocksPlayback).map((issue) => issue.message).slice(0, 3).join('；')
              || '目标计划被阻断',
            'warning',
          );
          return false;
        }
        const scopedPlan = reference.scopedPlan;
        playbackPlanId = reference.plan.planId;
        if (!launchScope || !scoreDoc.importReport) {
          setStarting(false);
          addFeedback('无法确认练习范围', '缺少完整的手别映射或导入报告，已阻止开始。', 'warning');
          return false;
        }
        const timelineBundle = buildPracticePlanBundleFromPlayback({
          plan: scopedPlan,
          config: {
            modeId: config.modeId,
            advanceMode: 'timeline',
            bpm: { numerator: config.tempo, denominator: 1 },
            range: scopedPlan.range,
            repeatSelection: { kind: 'none' },
            hand: config.hand,
            handMapping: launchScope.handMapping,
            countInUs,
            ticksPerQuarter: 960,
            unsupportedNotationPolicy: 'reject-strict',
            plannerVersion: TS_PLANNER_VERSION,
          },
          fingerprint: {
            document: scoreDoc.engine,
            report: scoreDoc.importReport,
            partId: launchScope.partId,
          },
        });
        assertPracticePlanBundle(timelineBundle);
        scoreEvents = engineScoreEventsFromBundle(timelineBundle);
        guideGroups = scopedPlan.groups;
        referencePlanRef.current = reference.plan;
        pendingReferencePlanRef.current = reference.plan;
        referenceMarkedIndexRef.current = 0;
        plan = {
          atoms: engineAtomsFromBundle(timelineBundle),
          expectedNotes: scopedPlan.groups.map((group) => group.pitches.map((pitch) => ({
            midiNote: pitch.midiNote ?? 0,
            noteName: pitch.spelling,
          }))),
          groupNoteIds: scopedPlan.groups.map((group) => [...group.scoreEventIds]),
        };
      } catch (error) {
        setStarting(false);
        addFeedback('无法生成练习目标', error instanceof Error ? error.message : String(error), 'warning');
        return false;
      }
    } else {
      referencePlanRef.current = null;
      pendingReferencePlanRef.current = null;
      plan = buildPracticePlan(scoreDoc.notes, loopActive ? 'loop' : config.modeId, config.hand, config.loopStartBar, config.loopEndBar);
      if (systemDuet) {
        addFeedback('参考播放不可用', '当前乐谱没有语义 MusicXML 计划；本次只播放节拍器，不启动参考演奏。', 'warning');
      }
    }
    if (plan.atoms.length === 0) {
      setStarting(false);
      addFeedback('没有可练习的目标', '当前小节范围内没有目标音符,请调整练习范围。', 'warning');
      return false;
    }
    expectedNotesRef.current = plan.expectedNotes;
    planGroupsRef.current = plan.groupNoteIds;
    if (guideGroups) {
      const toleranceMs = config.profile === 'strict' ? 30 : config.profile === 'relaxed' ? 100 : 60;
      guideSessionRef.current = new FollowSession(guideGroups, config.tempo, {
        timingToleranceMs: toleranceMs,
        chordSpreadToleranceMs: 50,
      });
      setGuideView({ index: 0, currentGroup: guideSessionRef.current.currentGroup, completed: 0 });
    } else {
      guideSessionRef.current = null;
      setGuideView(null);
    }
    void session.begin({
      modeId: engineMode,
      bpm: config.tempo,
      profile: config.profile,
      countInBeats,
      countInUs,
      ticksPerQuarter: 960,
      metronomeEnabled: metronomeOn,
      beatsPerBar: (config.timeSignature[0] * 4) / config.timeSignature[1],
      atoms: plan.atoms,
      ...(scoreEvents ? { scoreEvents } : {}),
      assisted: config.feedback === 'live',
      durationPolicy: config.durationPolicy,
      ...(scoreDoc.engine ? { scoreFingerprint: scoreDoc.engine.fingerprint } : {}),
      ...(playbackPlanId ? { playbackPlanId } : {}),
      scoreId: activeLibraryId ?? undefined,
      configSnapshot: config as unknown as Record<string, unknown>,
      // R2-3i: the TS path is also provenance-bearing; it has no plan
      // fingerprint by design (the frozen gate only covers the Rust plan).
      plannerAuthority: 'rts',
      plannerVersion: TS_PLANNER_VERSION,
      ...(scoreDoc.importReport ? { scoreImportStatus: scoreDoc.importReport.status } : {}),
      hand: config.hand,
      scoreBarCount: source?.scoreBarCount ?? scoreDoc.meta.barCount,
      ...(source ? {
        sourceReportId: source.sourceReportId,
        sourceTakeId: source.sourceTakeId,
      } : {}),
      ...(takeTemplateId ? { takeTemplateId } : {}),
    });
    addFeedback('练习已开始', `${modeRegistry[config.modeId].title} · ${config.tempo} BPM · ${config.hand === 'both' ? '双手' : config.hand === 'right' ? '右手' : '左手'} · 按后端首音时刻倒数，归零即第一个音。`, 'neutral');
    return true;
  };

  /**
   * Arms a practice launch from a Node-authored teaching practiceRequest.
   * The engine start itself still goes through the same PlanBundle/Rust
   * launch flow as any other practice; the workspace only pins the config
   * the server asked for. Returns false (and navigates nowhere) on mismatch.
   */
  const applyTeachingStepConfig = (request: {
    scoreFingerprint: string;
    tempo: number;
    hand: 'left' | 'right' | 'both';
    loopStartBar: number;
    loopEndBar: number;
  }): boolean => {
    if (session.active || starting) {
      addFeedback('当前仍有练习', '请先结束或重置当前练习，再开始教学步骤。', 'warning');
      return false;
    }
    if (!scoreDoc.engine || scoreDoc.engine.fingerprint !== request.scoreFingerprint) {
      addFeedback('教学曲谱不一致', '当前打开曲谱与本课程不一致，请先打开原曲谱再开始这一步。', 'warning');
      return false;
    }
    const { loopStartBar, loopEndBar } = request;
    if (!Number.isInteger(loopStartBar) || !Number.isInteger(loopEndBar)
      || loopStartBar < 1 || loopEndBar < loopStartBar || loopEndBar > scoreDoc.meta.barCount) {
      addFeedback('教学范围非法', '教学步骤的小节范围不在当前曲谱内，未开始练习。', 'warning');
      return false;
    }
    const nextConfig: PracticeConfig = {
      ...configRef.current,
      modeId: 'score',
      advanceMode: 'timeline',
      tempo: request.tempo,
      hand: request.hand,
      loopEnabled: true,
      loopStartBar,
      loopEndBar,
    };
    setConfig(nextConfig);
    setSettingsDraft(null);
    setShowSettings(false);
    if (route?.id !== 'workbench') navigate('/workbench');
    addFeedback(
      '教学步骤已就绪',
      `第 ${loopStartBar}–${loopEndBar} 小节 · ${request.tempo} BPM · 点「开始练习」时走既有的计划校验并创建新的 Take。`,
      'neutral',
    );
    return true;
  };

  const startPractice = () => {
    if (prepRemain !== null) return;
    const pendingDraft = settingsDraft;
    const draftDirty = pendingDraft !== null && (
      pendingDraft.metronomeOn !== metronomeOn
      || JSON.stringify(pendingDraft.config) !== JSON.stringify(config)
    );
    if (draftDirty) {
      setShowSettings(true);
      addFeedback('设置尚未保存', '请先点击「保存设置」再开始；本轮会使用已保存的配置快照。', 'warning');
      return;
    }
    void ensureSharedAudioContext().catch((error) => {
      addFeedback('音频引擎不可用', error instanceof Error ? error.message : String(error), 'warning');
    });
    clearReferencePlayback('restart');
    setSystemNoteIds([]);
    setUserNoteIds([]);
    guideSessionRef.current = null;
    setGuideView(null);
    systemPlayerRef.current?.stopAll();
    clearDuetTimers();
    if (systemDuet) {
      systemPlayerRef.current ??= new SystemDuetPlayer();
      systemPlayerRef.current.ensure();
    }
    // Timeline practice starts the engine immediately and counts down to the
    // backend's first-note time. A fixed client-side delay only added dead
    // time before the engine count-in and made the actual start ambiguous.
    if (configRef.current.advanceMode === 'timeline' && configRef.current.modeId !== 'free') {
      launchPractice();
      return;
    }
    setPrepRemain(3);
    const startedAt = performance.now();
    if (prepTimerRef.current !== null) window.clearTimeout(prepTimerRef.current);
    const tick = () => {
      const remaining = Math.max(0, 3 - Math.floor((performance.now() - startedAt) / 1000));
      if (remaining <= 0) {
        prepTimerRef.current = null;
        setPrepRemain(null);
        launchPractice();
        return;
      }
      setPrepRemain(remaining);
      prepTimerRef.current = window.setTimeout(tick, 100);
    };
    prepTimerRef.current = window.setTimeout(tick, 100);
  };

  const pausePractice = () => {
    if (config.advanceMode === 'follow') {
      if (followStatusRef.current !== 'running') return;
      elapsedBeforePauseRef.current = elapsed;
      const pausedAtMs = displayStartRef.current !== null
        ? performance.now() - displayStartRef.current
        : undefined;
      session.pauseFollow(pausedAtMs);
      followStatusRef.current = 'paused';
      setFollowStatus('paused');
      addFeedback('跟手练习已暂停', '光标停在当前目标；继续后不会自动前进，弹对当前目标才会推进。', 'neutral');
      return;
    }
    if (session.status !== 'running' && session.status !== 'countdown') return;
    elapsedBeforePauseRef.current = elapsed;
    referencePlaybackRef.current?.pause('user');
    session.pause();
    addFeedback('练习已暂停', '节拍器和参考播放已停止;恢复时剩余目标会整体顺延,暂停时长不会算进偏差。', 'neutral');
  };
  pauseSessionForAudioRef.current = pausePractice;

  const resumePractice = () => {
    if (config.advanceMode === 'follow') {
      if (followStatusRef.current !== 'paused') return;
      const resumedAtMs = displayStartRef.current !== null
        ? performance.now() - displayStartRef.current
        : undefined;
      session.resumeFollow(resumedAtMs);
      followStatusRef.current = 'running';
      setFollowStatus('running');
      addFeedback('跟手练习已继续', '光标仍在当前目标，弹对后才会前进；暂停后的下一个间隔不计入节奏统计。', 'neutral');
      return;
    }
    if (session.status !== 'paused') return;
    displayStartRef.current = performance.now() - elapsedBeforePauseRef.current * 1000;
    guideSessionRef.current?.invalidateNextInterval();
    session.resume();
    void referencePlaybackRef.current?.resume();
    addFeedback('练习已继续', '剩余目标时间已顺延,参考播放从暂停位置继续。', 'neutral');
  };

  const finishPractice = () => {
    if (config.advanceMode === 'follow') {
      if (followStatusRef.current === 'idle'
        || followStatusRef.current === 'processing'
        || followStatusRef.current === 'completed') return;
      // The service computes and commits the Follow report; this button only
      // asks for that finalization. Duplicate finishes return the same Take.
      session.finishFollow();
      followStatusRef.current = 'processing';
      setFollowStatus('processing');
      addFeedback('正在结算跟手练习', '引擎正在计算 Follow 报告并写入一个 Take，稍候展示结果。', 'neutral');
      return;
    }
    if (session.status === 'idle' || session.status === 'processing' || session.status === 'completed') return;
    referencePlaybackRef.current?.stop('finish');
    if (config.modeId === 'free') {
      session.finishFreePlay();
      addFeedback('自由弹奏已结束', `共记录 ${events.filter(event => event.type === 'note-on').length} 次按键。自由模式不做谱面评分。`, 'neutral');
      return;
    }
    session.finish();
    addFeedback('正在生成报告', '引擎正在对原始事件做确定性重放,稍候展示结果。', 'neutral');
  };

  const handleStayInPractice = () => {
    pendingLeaveRef.current = null;
    pendingFinishIssuedRef.current = false;
    setLeaveBusy(false);
    setLeaveError(null);
    setLeaveRequest(null);
  };

  const handleFinishAndLeave = () => {
    const target = leaveRequest?.targetPath;
    if (!target || leaveBusy) return;
    if (!practiceInProgress) {
      setLeaveRequest(null);
      navigate(target);
      return;
    }
    setLeaveError(null);
    pendingLeaveRef.current = target;
    pendingFinishIssuedRef.current = false;
    setLeaveBusy(true);

    // The 3-second preparation is not a Take yet; cancel it instead of
    // starting a session in a page the user is leaving.
    if (prepRemain !== null && !session.active) {
      pendingLeaveRef.current = null;
      cancelPrep();
      setLeaveBusy(false);
      setLeaveRequest(null);
      navigate(target);
      return;
    }

    // A bridge start is in flight; the effect below finishes the Take once
    // the engine reports countdown/running instead of creating a background one.
    if (starting && !session.active) return;
    if (session.status === 'processing') return;

    pendingFinishIssuedRef.current = true;
    finishPractice();
  };

  useEffect(() => {
    if (!leaveBusy) return;
    const target = pendingLeaveRef.current;
    if (!target) return;

    if (session.error && session.status !== 'completed') {
      pendingLeaveRef.current = null;
      pendingFinishIssuedRef.current = false;
      setLeaveBusy(false);
      setLeaveError(session.error);
      return;
    }

    if (practiceInProgress) {
      if (!pendingFinishIssuedRef.current && !prepRemain && !starting) {
        pendingFinishIssuedRef.current = true;
        finishPractice();
      }
      return;
    }

    if (config.advanceMode !== 'follow' && config.modeId !== 'free') {
      if (!session.report) {
        pendingLeaveRef.current = null;
        pendingFinishIssuedRef.current = false;
        setLeaveBusy(false);
        setLeaveError(null);
        setLeaveRequest(null);
        addFeedback('未离开练习室', '本轮没有生成可评分报告；未执行导航。请检查输入/时钟后新开一轮。', 'warning');
        return;
      }
      if (session.reportPersisted === false) {
        pendingLeaveRef.current = null;
        pendingFinishIssuedRef.current = false;
        setLeaveBusy(false);
        setLeaveError(null);
        setLeaveRequest(null);
        addFeedback('未离开练习室', `报告已生成但未能保存：${session.reportPersistenceError ?? '持久化失败'}。`, 'warning');
        return;
      }
    }

    pendingLeaveRef.current = null;
    pendingFinishIssuedRef.current = false;
    setLeaveBusy(false);
    setLeaveError(null);
    setLeaveRequest(null);
    navigate(target);
  }, [leaveBusy, practiceInProgress, session.status, session.error, session.report, session.reportPersisted, session.reportPersistenceError, config.advanceMode, config.modeId, navigate]);

  useEffect(() => {
    if (!practiceInProgress && !reportUnsaved) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [practiceInProgress, reportUnsaved]);

  const resetPractice = () => {
    const followActive = followStatusRef.current === 'running' || followStatusRef.current === 'paused' || followStatusRef.current === 'processing';
    if ((session.active || followActive) && !window.confirm('正在练习,确定要重置并丢弃当前会话进度吗?')) return;
    cancelPrep();
    clearReferencePlayback('reset');
    systemPlayerRef.current?.stopAll();
    clearDuetTimers();
    guideSessionRef.current = null;
    setGuideView(null);
    setSystemNoteIds([]);
    setUserNoteIds([]);
    clearFollowSession();
    session.reset();
    setElapsed(0); setEvents([]); setInputNote('—'); setPitchMismatch(false);
    setLastInputMidi(null);
    expectedNotesRef.current = []; planGroupsRef.current = [];
    setFeedbackItems([]); elapsedBeforePauseRef.current = 0; displayStartRef.current = null; setStarting(false);
  };

  const applyScoreDocument = (doc: ScoreDocument, feedbackTitle: string): boolean => {
    const followActive = followStatusRef.current === 'running' || followStatusRef.current === 'paused' || followStatusRef.current === 'processing';
    if ((session.active || followActive) && !window.confirm('当前练习正在进行。切换乐谱会结束并重置本次会话，是否继续?')) return false;
    scoreSelectionVersionRef.current += 1;
    cancelPrep();
    clearReferencePlayback('score-changed');
    systemPlayerRef.current?.stopAll();
    clearDuetTimers();
    guideSessionRef.current = null;
    setGuideView(null);
    setSystemNoteIds([]);
    setUserNoteIds([]);
    clearFollowSession();
    session.reset();
    setScoreDoc(doc);
    setConfig(prev => ({
      ...prev,
      timeSignature: [doc.meta.timeSignature[0], doc.meta.timeSignature[1]] as [number, number],
      hand: 'both',
      loopStartBar: 1,
      loopEndBar: doc.meta.barCount,
    }));
    setSettingsDraft(prev => prev ? {
      ...prev,
      config: {
        ...prev.config,
        timeSignature: [doc.meta.timeSignature[0], doc.meta.timeSignature[1]] as [number, number],
        hand: 'both',
        loopStartBar: 1,
        loopEndBar: doc.meta.barCount,
      },
    } : prev);
    setElapsed(0); setEvents([]); setFeedbackItems([]); setInputNote('—'); setPitchMismatch(false);
    setLastInputMidi(null);
    expectedNotesRef.current = []; planGroupsRef.current = [];
    elapsedBeforePauseRef.current = 0; displayStartRef.current = null; setStarting(false);
    addFeedback(
      feedbackTitle,
      `${doc.meta.title} · ${doc.meta.barCount} 小节 · ${doc.notes.length} 个音符${doc.warnings.length ? ` · ${doc.warnings.length} 条导入提示` : ''}`,
      doc.warnings.length ? 'warning' : 'success',
    );
    return true;
  };

  const libraryErrorText = (error: unknown) => error instanceof Error ? error.message : String(error);

  const rememberActiveScore = (id: string | null) => {
    setActiveLibraryId(id);
    saveStoredActiveScoreId(id);
  };

  // Restore the last library score after a refresh. This is why the workbench
  // no longer snaps back to the built-in fixture when the page reloads.
  useEffect(() => {
    const storedId = loadStoredActiveScoreId();
    if (!storedId) {
      setScoreRestoreState('ready');
      return;
    }
    let cancelled = false;
    const restoreVersion = scoreSelectionVersionRef.current;
    setScoreRestoreState('loading');
    void (async () => {
      try {
        const entry = await getScoreLibraryEntry(storedId);
        if (cancelled || scoreSelectionVersionRef.current !== restoreVersion) return;
        const doc = parseMusicXml(entry.xml, entry.fileName);
        if (scoreSelectionVersionRef.current !== restoreVersion) return;
        if (applyScoreDocument(doc, `已恢复上次乐谱《${entry.name}》`)) {
          setActiveLibraryId(entry.id);
          setSelectedLibraryId(entry.id);
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ScoreLibraryClientError && error.status === 404) {
          saveStoredActiveScoreId(null);
          addFeedback('上次乐谱已不在乐谱库', '已回到默认乐谱；请在练习设置中重新选择。', 'warning');
        } else {
          addFeedback('未能恢复上次乐谱', libraryErrorText(error), 'warning');
        }
      } finally {
        if (!cancelled) setScoreRestoreState('ready');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const refreshScoreLibrary = useCallback(async (preferredId?: string) => {
    setScoreLibraryBusy(true);
    try {
      const entries = await listScoreLibrary();
      setScoreLibrary(entries);
      setScoreLibraryError(null);
      setSelectedLibraryId(prev => {
        if (preferredId && entries.some(entry => entry.id === preferredId)) return preferredId;
        if (prev && entries.some(entry => entry.id === prev)) return prev;
        return entries[0]?.id ?? '';
      });
    } catch (error) {
      setScoreLibraryError(libraryErrorText(error));
    } finally {
      setScoreLibraryBusy(false);
    }
  }, []);

  useEffect(() => {
    if (showSettings) void refreshScoreLibrary();
  }, [showSettings, refreshScoreLibrary]);

  const takeTemplateErrorText = (error: unknown) => (
    error instanceof TakeTemplateClientError ? error.message : error instanceof Error ? error.message : String(error)
  );

  const refreshTakeTemplates = useCallback(async (preferredId?: string) => {
    try {
      const entries = await takeTemplateRepository.list();
      setTakeTemplates(entries);
      setTakeTemplateError(null);
      setSelectedTakeTemplateId((prev) => {
        if (preferredId && entries.some((entry) => entry.id === preferredId)) return preferredId;
        if (prev && entries.some((entry) => entry.id === prev)) return prev;
        return entries[0]?.id ?? '';
      });
      setAppliedTakeTemplateId((prev) => (prev && entries.some((entry) => entry.id === prev) ? prev : null));
    } catch (error) {
      setTakeTemplateError(takeTemplateErrorText(error));
    }
  }, []);

  useEffect(() => { void refreshTakeTemplates(); }, [refreshTakeTemplates]);
  useEffect(() => {
    if (showSettings) void refreshTakeTemplates();
  }, [showSettings, refreshTakeTemplates]);

  const saveCurrentAsTakeTemplate = async () => {
    if (settingsLocked) {
      warnSettingsLocked();
      return;
    }
    const defaultName = `${scoreDoc.meta.title} · ${config.tempo} BPM · ${config.hand === 'right' ? '右手' : config.hand === 'left' ? '左手' : '双手'}${config.loopEnabled ? ` · 第 ${config.loopStartBar}–${config.loopEndBar} 小节` : ''}`;
    const name = window.prompt('保存为本机 Take 名称', defaultName);
    if (name === null) return;
    setTakeTemplateBusy(true);
    try {
      const created = await takeTemplateRepository.create({
        name,
        config,
        scoreFingerprint: scoreDoc.engine?.fingerprint ?? null,
        scoreLabel: scoreDoc.meta.title,
        scoreLibraryId: activeLibraryId,
      });
      await refreshTakeTemplates(created.id);
      setSelectedTakeTemplateId(created.id);
      setTakeTemplateError(null);
      addFeedback('Take 已保存', `「${created.name}」已保存；下次可在设置中选择它。`, 'success');
    } catch (error) {
      setTakeTemplateError(takeTemplateErrorText(error));
      addFeedback('Take 保存失败', takeTemplateErrorText(error), 'warning');
    } finally {
      setTakeTemplateBusy(false);
    }
  };

  const applyTakeTemplateConfig = (template: TakeTemplate, feedbackTitle = '已应用 Take'): boolean => {
    const currentFingerprint = scoreDoc.engine?.fingerprint ?? null;
    if (template.scoreFingerprint && template.scoreFingerprint !== currentFingerprint) {
      setTakeTemplateError('当前打开的曲谱与这个 Take 不一致；请先打开原曲谱。');
      return false;
    }
    const loopStartBar = Math.min(Math.max(1, template.config.loopStartBar), maxBar);
    const loopEndBar = Math.max(loopStartBar, Math.min(template.config.loopEndBar, maxBar));
    if (template.config.loopEnabled && (loopStartBar !== template.config.loopStartBar || loopEndBar !== template.config.loopEndBar)) {
      setTakeTemplateError('这个 Take 的小节范围超出当前曲谱。');
      return false;
    }
    const nextConfig: PracticeConfig = {
      ...template.config,
      loopStartBar,
      loopEndBar,
    };
    setConfig(nextConfig);
    setSettingsDraft(null);
    setSettingsSaved(true);
    savePracticeSettings({ config: nextConfig, metronomeOn });
    setAppliedTakeTemplateId(template.id);
    setTakeTemplateError(null);
    addFeedback(feedbackTitle, `「${template.name}」已载入配置；开始练习后会关联这条 Take。`, 'success');
    return true;
  };

  const applyTakeTemplate = () => {
    if (settingsLocked) {
      warnSettingsLocked();
      return;
    }
    const template = takeTemplates.find((item) => item.id === selectedTakeTemplateId);
    if (!template) {
      setTakeTemplateError('请选择一个已保存的 Take。');
      return;
    }
    applyTakeTemplateConfig(template);
  };

  // Tablet/deep-link entry: /workbench?takeTemplate=<id> applies a saved
  // template once after the shared list arrives, so a second device does not
  // have to reproduce every settings toggle by hand.
  useEffect(() => {
    if (autoAppliedTakeTemplateRef.current) return;
    const requestedId = new URLSearchParams(window.location.search).get('takeTemplate');
    if (!requestedId || takeTemplates.length === 0) return;
    const template = takeTemplates.find((item) => item.id === requestedId);
    if (!template) {
      autoAppliedTakeTemplateRef.current = true;
      setTakeTemplateError('链接中的 Take 不存在或已被删除。');
      return;
    }
    if (prepRemain !== null || starting || session.active
      || followStatus === 'running' || followStatus === 'paused' || followStatus === 'processing') {
      setTakeTemplateError('当前还有进行中的练习，不能通过链接切换 Take。');
      return;
    }
    autoAppliedTakeTemplateRef.current = true;
    if (applyTakeTemplateConfig(template, '已从链接应用 Take')) {
      const url = new URL(window.location.href);
      url.searchParams.delete('takeTemplate');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, [takeTemplates, prepRemain, starting, session.active, followStatus, scoreDoc, maxBar, metronomeOn]);

  const renameTakeTemplate = async () => {
    const template = takeTemplates.find((item) => item.id === selectedTakeTemplateId);
    if (!template) return;
    const name = window.prompt('新的 Take 名称', template.name);
    if (name === null) return;
    setTakeTemplateBusy(true);
    try {
      const updated = await takeTemplateRepository.update(template.id, { name });
      await refreshTakeTemplates(updated.id);
      setTakeTemplateError(null);
    } catch (error) {
      setTakeTemplateError(takeTemplateErrorText(error));
    } finally {
      setTakeTemplateBusy(false);
    }
  };

  const deleteTakeTemplate = async () => {
    const template = takeTemplates.find((item) => item.id === selectedTakeTemplateId);
    if (!template) return;
    if (!window.confirm(`删除 Take「${template.name}」？历史报告不会被删除。`)) return;
    setTakeTemplateBusy(true);
    try {
      await takeTemplateRepository.remove(template.id);
      if (appliedTakeTemplateId === template.id) setAppliedTakeTemplateId(null);
      await refreshTakeTemplates();
      setTakeTemplateError(null);
    } catch (error) {
      setTakeTemplateError(takeTemplateErrorText(error));
    } finally {
      setTakeTemplateBusy(false);
    }
  };

  const scoreNameFromFile = (fileName: string) => fileName.replace(/\.(musicxml|xml)$/i, '').trim() || '未命名乐谱';
  const uniqueLibraryName = (baseName: string) => {
    const base = baseName.slice(0, 60);
    const names = new Set(scoreLibrary.map(entry => entry.name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    let index = 2;
    let candidate = `${base} (${index})`;
    while (names.has(candidate.toLowerCase())) {
      index += 1;
      candidate = `${base} (${index})`;
    }
    return candidate;
  };

  const handleScoreFile = async (file: File) => {
    let result: ReturnType<typeof importScoreText>;
    try {
      const xml = await file.text();
      result = importScoreText(xml, file.name);
    } catch (error) {
      addFeedback('MusicXML 导入失败', libraryErrorText(error), 'warning');
      if (scoreFileInputRef.current) scoreFileInputRef.current.value = '';
      return;
    }
    if (!result.doc || result.report.status === 'REJECTED') {
      const reasons = result.report.issues.map((issue) => issue.message).slice(0, 3).join('；');
      addFeedback('MusicXML 导入失败', reasons || '语义解析失败', 'warning');
      if (scoreFileInputRef.current) scoreFileInputRef.current.value = '';
      return;
    }
    const applied = applyScoreDocument(result.doc, '乐谱已导入');
    if (scoreFileInputRef.current) scoreFileInputRef.current.value = '';
    if (!applied) return;
    rememberActiveScore(null);
    try {
      const name = uniqueLibraryName(scoreNameFromFile(file.name));
      const entry = await createScoreLibraryEntry({
        name,
        fileName: file.name,
        xml: result.xml,
        importSummary: summarizeImportReport(result.report),
      });
      rememberActiveScore(entry.id);
      setSelectedLibraryId(entry.id);
      await refreshScoreLibrary(entry.id);
      addFeedback('已保存到乐谱库', `《${entry.name}》已保存；下次可在设置中按名称载入。`, 'success');
    } catch (error) {
      const message = libraryErrorText(error);
      setScoreLibraryError(message);
      addFeedback('乐谱已导入，但未存入乐谱库', message, 'warning');
    }
  };

  const loadScoreFromLibrary = async (id: string) => {
    if (!id) return;
    setScoreLibraryBusy(true);
    try {
      const entry = await getScoreLibraryEntry(id);
      const result = importScoreText(entry.xml, entry.fileName);
      if (!result.doc || result.report.status === 'REJECTED') {
        throw new Error(result.report.issues.map((issue) => issue.message).slice(0, 3).join('；') || '语义解析失败');
      }
      if (applyScoreDocument(result.doc, `已载入《${entry.name}》`)) {
        rememberActiveScore(entry.id);
        setSelectedLibraryId(entry.id);
        if (!entry.importStatus) {
          try {
            await updateScoreLibraryEntry(entry.id, { importSummary: summarizeImportReport(result.report) });
          } catch { /* status backfill is best effort */ }
        }
      }
    } catch (error) {
      const message = libraryErrorText(error);
      setScoreLibraryError(message);
      addFeedback('乐谱库载入失败', message, 'warning');
    } finally {
      setScoreLibraryBusy(false);
    }
  };

  const handleOpenLibraryScore = (entry: ScoreLibraryEntry, doc: ScoreDocument): boolean => {
    if (!applyScoreDocument(doc, `已打开《${entry.name}》`)) return false;
    rememberActiveScore(entry.id);
    setSelectedLibraryId(entry.id);
    setScoreRestoreState('ready');
    navigate('/reader');
    return true;
  };

  const handleActiveScoreRemoved = (id: string) => {
    if (activeLibraryId !== id) return;
    rememberActiveScore(null);
    if (session.active) {
      addFeedback('当前谱面已从曲谱库删除', '当前练习仍使用内存中的曲谱继续；结束后请从曲谱库重新选择或导入。', 'warning');
      return;
    }
    scoreSelectionVersionRef.current += 1;
    setScoreDoc(practiceScoreDocument);
    setScoreRestoreState('ready');
    addFeedback('当前谱面已从曲谱库删除', '已回到默认乐谱；请从曲谱库重新选择或导入。', 'warning');
  };

  const handleStartPracticeFromReader = () => {
    if (!showSettings) {
      setSettingsDraft({ config, metronomeOn });
      setSettingsSaved(false);
      setShowSettings(true);
    }
    navigate('/workbench');
  };

  const renameScoreLibraryEntry = async () => {
    const entry = scoreLibrary.find(item => item.id === selectedLibraryId);
    if (!entry) return;
    const answer = window.prompt('新的乐谱名称', entry.name);
    if (answer === null) return;
    const name = answer.trim();
    if (!name || name === entry.name) return;
    setScoreLibraryBusy(true);
    try {
      const updated = await updateScoreLibraryEntry(entry.id, { name });
      await refreshScoreLibrary(updated.id);
      addFeedback('乐谱已重命名', `《${entry.name}》→《${updated.name}》`, 'success');
    } catch (error) {
      const message = libraryErrorText(error);
      setScoreLibraryError(message);
      addFeedback('乐谱重命名失败', message, 'warning');
    } finally {
      setScoreLibraryBusy(false);
    }
  };

  const requestLibraryReplace = () => {
    if (!selectedLibraryId) return;
    setReplaceLibraryTarget(selectedLibraryId);
    libraryReplaceInputRef.current?.click();
  };

  const handleLibraryReplaceFile = async (file: File) => {
    const targetId = replaceLibraryTarget ?? selectedLibraryId;
    setReplaceLibraryTarget(null);
    if (libraryReplaceInputRef.current) libraryReplaceInputRef.current.value = '';
    if (!targetId) return;
    let result: ReturnType<typeof importScoreText>;
    try {
      result = importScoreText(await file.text(), file.name);
    } catch (error) {
      addFeedback('替换失败：XML 无法解析', libraryErrorText(error), 'warning');
      return;
    }
    if (!result.doc || result.report.status === 'REJECTED') {
      const reasons = result.report.issues.map((issue) => issue.message).slice(0, 3).join('；');
      addFeedback('替换失败：语义解析失败', reasons || '新 XML 不能作为可用曲谱；旧版本保持不变。', 'warning');
      return;
    }
    const doc = result.doc;
    setScoreLibraryBusy(true);
    try {
      const updated = await updateScoreLibraryEntry(targetId, {
        xml: result.xml,
        fileName: file.name,
        importSummary: summarizeImportReport(result.report),
      });
      const wasActive = activeLibraryId === targetId;
      if (wasActive) rememberActiveScore(null);
      await refreshScoreLibrary(updated.id);
      let reloaded = false;
      if (wasActive) {
        reloaded = applyScoreDocument(doc, `已替换《${updated.name}》`);
        if (reloaded) rememberActiveScore(updated.id);
      }
      addFeedback('乐谱 XML 已替换', `《${updated.name}》已更新${reloaded ? '，当前谱面已重新载入' : ''}。`, 'success');
    } catch (error) {
      const message = libraryErrorText(error);
      setScoreLibraryError(message);
      addFeedback('乐谱替换失败', message, 'warning');
    } finally {
      setScoreLibraryBusy(false);
    }
  };

  const removeScoreLibraryEntry = async () => {
    const entry = scoreLibrary.find(item => item.id === selectedLibraryId);
    if (!entry) return;
    if (!window.confirm(`从乐谱库删除《${entry.name}》？此操作不可撤销。`)) return;
    setScoreLibraryBusy(true);
    try {
      await deleteScoreLibraryEntry(entry.id);
      if (activeLibraryId === entry.id) rememberActiveScore(null);
      setSelectedLibraryId('');
      await refreshScoreLibrary();
      addFeedback('已从乐谱库删除', `《${entry.name}》已删除；当前谱面保持不变。`, 'neutral');
    } catch (error) {
      const message = libraryErrorText(error);
      setScoreLibraryError(message);
      addFeedback('删除乐谱失败', message, 'warning');
    } finally {
      setScoreLibraryBusy(false);
    }
  };

  const loadLedgerDemo = () => {
    try {
      const doc = parseMusicXml(ledgerDemoXml, 'ledger-lines-demo.musicxml');
      if (applyScoreDocument(doc, '已载入谱表外示例')) rememberActiveScore(null);
    } catch (error) {
      addFeedback('示例载入失败', libraryErrorText(error), 'warning');
    }
  };

  const restoreDefaultScore = () => {
    if (applyScoreDocument(practiceScoreDocument, '已恢复默认乐谱')) rememberActiveScore(null);
  };
  const requestScoreImport = () => scoreFileInputRef.current?.click();

  const chooseMode = (modeId: PracticeModeId) => {
    if (modeId === config.modeId) {
      if (route?.id !== 'workbench') navigate('/workbench');
      return;
    }
    const followActive = followStatusRef.current === 'running' || followStatusRef.current === 'paused' || followStatusRef.current === 'processing';
    if ((session.active || followActive) && !window.confirm('当前练习正在进行。切换模式会结束本次会话并创建新的练习,是否继续?')) return;
    cancelPrep();
    setAppliedTakeTemplateId(null);
    clearReferencePlayback('mode-changed');
    systemPlayerRef.current?.stopAll();
    clearDuetTimers();
    guideSessionRef.current = null;
    setGuideView(null);
    setSystemNoteIds([]);
    setUserNoteIds([]);
    clearFollowSession();
    session.reset();
    const nextHand: HandSelection = modeId === 'hands' && config.hand === 'both' ? 'right' : config.hand;
    setConfig(prev => ({ ...prev, modeId, hand: nextHand }));
    setSettingsDraft(prev => prev ? { ...prev, config: { ...prev.config, modeId, hand: nextHand } } : prev);
    setSettingsSaved(false);
    setElapsed(0); setEvents([]); setFeedbackItems([]); setInputNote('—'); setPitchMismatch(false);
    setLastInputMidi(null);
    expectedNotesRef.current = []; planGroupsRef.current = [];
    elapsedBeforePauseRef.current = 0; displayStartRef.current = null; setStarting(false);
    if (route?.id !== 'workbench') navigate('/workbench');
  };

  const settingsLocked = prepRemain !== null
    || starting
    || session.active
    || followStatus === 'running'
    || followStatus === 'paused';
  const settingsView: PersistedPracticeSettings = settingsDraft ?? { config, metronomeOn };

  // P1-4: staff -> hand mapping editor. The draft starts from the user's saved
  // mapping or, if none, from the clef heuristic as a DISPLAY suggestion with
  // that origin marked; only "确认手别映射" persists it as source='user'.
  const engineFingerprintForMapping = scoreDoc.engine?.fingerprint ?? null;
  const mappingPartId = scoreDoc.engine?.parts[0]?.id ?? 'P1';
  const savedMappingForScore = engineFingerprintForMapping
    ? userHandMappingFor(engineFingerprintForMapping, mappingPartId)
    : null;
  const staffMappingDraft: Array<{ staffNumber: number; hand: 'left' | 'right' }> = (() => {
    if (savedMappingForScore) {
      const entry = savedMappingForScore.parts.find((part) => part.partId === mappingPartId);
      if (entry) return entry.staves.map((staff) => ({ ...staff }));
    }
    if (!scoreDoc.engine) return [];
    const suggested = suggestClefHeuristicMapping(scoreDoc.engine, mappingPartId);
    const entry = suggested.parts[0];
    return entry ? entry.staves.map((staff) => ({ ...staff })) : [];
  })();
  const updateStaffMappingDraft = (staffNumber: number, hand: 'left' | 'right') => {
    setStaffMappingOverrides((prev) => ({ ...prev, [staffNumber]: hand }));
  };
  const confirmStaffMapping = () => {
    if (!engineFingerprintForMapping) return;
    const staves = staffMappingDraft.map((entry) => ({
      staffNumber: entry.staffNumber,
      hand: staffMappingOverrides[entry.staffNumber] ?? entry.hand,
    }));
    if (staves.length === 0) return;
    rememberHandMapping(engineFingerprintForMapping, buildUserHandMapping(mappingPartId, staves));
    addFeedback('手别映射已确认', '严格计分将使用这套谱表→手别映射；多 Part 乐谱按当前所选 Part。', 'success');
  };
  const selectedLibraryEntry = scoreLibrary.find(entry => entry.id === selectedLibraryId) ?? null;
  const activeLibraryEntry = scoreLibrary.find(entry => entry.id === activeLibraryId) ?? null;
  const settingsDirty = !!settingsDraft && (
    settingsDraft.metronomeOn !== metronomeOn
    || JSON.stringify(settingsDraft.config) !== JSON.stringify(config)
  );

  const closeSettingsPanel = () => {
    setShowSettings(false);
    setSettingsDraft(null);
    setSettingsSaved(false);
  };

  const toggleSettingsPanel = () => {
    if (showSettings) {
      closeSettingsPanel();
      return;
    }
    // The settings panel lives in the workbench; make the global gear
    // actionable from history/profile instead of opening an invisible panel.
    if (route?.id !== 'workbench') requestNavigation('/workbench');
    setSettingsDraft({ config, metronomeOn });
    setSettingsSaved(false);
    setShowSettings(true);
  };

  const warnSettingsLocked = () => {
    addFeedback('先结束本次练习', '为避免评估条件中途变化,请先结束或重置当前练习,再修改设置。', 'warning');
  };

  const updateSettingsDraft = <K extends keyof PracticeConfig>(key: K, value: PracticeConfig[K]) => {
    if (settingsLocked) {
      warnSettingsLocked();
      return;
    }
    setSettingsSaved(false);
    setAppliedTakeTemplateId(null);
    setSettingsDraft(prev => prev ? { ...prev, config: { ...prev.config, [key]: value } } : prev);
  };

  const toggleMetronomeDraft = () => {
    if (settingsLocked) {
      warnSettingsLocked();
      return;
    }
    setSettingsSaved(false);
    setSettingsDraft(prev => prev ? { ...prev, metronomeOn: !prev.metronomeOn } : prev);
  };

  /** Draft edits only take effect here: apply, persist on this device, keep the panel open. */
  const saveSettingsDraft = () => {
    if (!settingsDraft) return;
    if (settingsLocked) {
      warnSettingsLocked();
      return;
    }
    const barLimit = Math.max(1, maxBar);
    const loopStartBar = Math.min(Math.max(1, settingsDraft.config.loopStartBar), barLimit);
    const loopEndBar = Math.max(loopStartBar, Math.min(Math.max(1, settingsDraft.config.loopEndBar), barLimit));
    const nextSettings: PersistedPracticeSettings = {
      config: {
        ...settingsDraft.config,
        modeId: configRef.current.modeId,
        loopStartBar,
        loopEndBar,
      },
      metronomeOn: settingsDraft.metronomeOn,
    };
    if (nextSettings.config.advanceMode !== configRef.current.advanceMode) clearFollowSession();
    setConfig(nextSettings.config);
    setMetronomeOn(nextSettings.metronomeOn);
    savePracticeSettings(nextSettings);
    setSettingsDraft(nextSettings);
    setSettingsSaved(true);
    addFeedback('设置已保存', '练习参数已应用，并会在这台设备上保留，下次打开页面自动恢复。', 'success');
  };

  const simulateNote = (note?: number) => {
    const expectedGroup = expectedNotesRef.current[Math.min(session.nextUnmatchedIndex, Math.max(expectedNotesRef.current.length - 1, 0))];
    const followFallback = config.advanceMode === 'follow' ? followView?.currentGroup?.pitches[0]?.midiNote : undefined;
    const fallback = followFallback ?? expectedGroup?.[0]?.midiNote ?? 60;
    handleRawPacket(buildMockPacket(true, note ?? fallback));
    // Simulated hold: 90% of the current target's nominal duration — inside
    // tolerance, so the duration report only flags real release mistakes.
    const pitch = note ?? fallback;
    const nominal = session.targets[Math.min(session.nextUnmatchedIndex, Math.max(session.targets.length - 1, 0))]?.nominalDurationMs ?? 750;
    window.setTimeout(() => {
      handleRawPacket(buildMockPacket(false, pitch));
    }, Math.max(120, Math.round(nominal * 0.9)));
  };

  /** Virtual key press & hold: Note On on pointer-down, Note Off on release. */
  const virtualKeyDown = (note: number) => {
    handleRawPacket(buildMockPacket(true, note));
  };
  const virtualKeyUp = (note: number) => {
    handleRawPacket(buildMockPacket(false, note));
  };

  useEffect(() => {
    if (session.status !== 'idle' || session.error) setStarting(false);
  }, [session.status, session.error]);

  const uiStatus: SessionStatus = config.advanceMode === 'follow' ? followStatus : session.status;

  // Why a teaching practice step cannot start right now (shown inline on
  // /teaching instead of failing after navigating to the workbench).
  const teachingPracticeBlock: string | null = (() => {
    if (!scoreDoc.engine) return '当前曲谱缺少语义引擎数据，无法创建练习计划。';
    if (scoreDoc.engine.parts.length > 1) return '多 Part 乐谱暂不支持严格练习，无法开始这一步。';
    const fingerprint = scoreDoc.engine.fingerprint;
    const partId = scoreDoc.engine.parts[0]?.id ?? 'P1';
    if (!userHandMappingFor(fingerprint, partId)) {
      return '尚未确认「谱表→手别映射」；请到练习工作台打开练习设置确认后回来开始这一步。';
    }
    if (session.active || starting || followStatusRef.current === 'running' || followStatusRef.current === 'paused' || followStatusRef.current === 'processing') {
      return '当前有练习进行中；请先结束或重置，再开始教学步骤。';
    }
    return null;
  })();

  useEffect(() => {
    if (uiStatus !== 'running' && session.status !== 'countdown') return;
    const timer = window.setInterval(() => {
      if (displayStartRef.current !== null) setElapsed(Math.max(0, (performance.now() - displayStartRef.current) / 1000));
    }, 100);
    return () => window.clearInterval(timer);
  }, [uiStatus, session.status]);

  const status = uiStatus;
  const statusLabel = prepRemain !== null ? `准备 ${prepRemain}s` : status === 'countdown' ? '倒数到第一个音'
    : status === 'running' ? (config.advanceMode === 'follow' ? '跟手练习中' : '练习中')
    : status === 'paused' ? '已暂停'
    : status === 'processing' ? '生成报告中'
    : status === 'completed' ? '已结束' : '准备中';
  const statusClass = prepRemain !== null ? 'is-countdown' : status === 'running' ? 'is-running'
    : status === 'paused' ? 'is-paused'
    : status === 'countdown' ? 'is-countdown'
    : status === 'processing' ? 'is-processing'
    : status === 'completed' ? 'is-complete' : 'is-idle';
  const referenceStatusLabel = !systemDuet
    ? '关闭'
    : !referenceSnapshot
      ? '待机'
      : `${referenceSnapshot.status === 'COUNT_IN' ? '预备拍'
        : referenceSnapshot.status === 'PLAYING' ? '播放中'
        : referenceSnapshot.status === 'PAUSED' ? '已暂停'
        : referenceSnapshot.status === 'COMPLETED' ? '已完成'
        : referenceSnapshot.status === 'FAILED' ? '失败'
        : referenceSnapshot.status === 'STOPPED' ? '已停止'
        : '准备中'}${referenceSnapshot.health === 'DEGRADED' ? ' · 降级' : ''}`;
  const referencePositionLabel = referenceSnapshot && referenceSnapshot.measureIndex > 0
    ? `第 ${referenceSnapshot.measureIndex} 小节`
    : '';

  const lastJudgment = session.judgments.length ? session.judgments[session.judgments.length - 1] : null;
  const followLast = config.advanceMode === 'follow' ? followView?.last ?? null : null;
  const lastHit: 'good' | 'miss' | 'extra' | 'waiting'
    = !lastJudgment ? 'waiting'
    : lastJudgment.grade === 'perfect' || lastJudgment.grade === 'good' ? 'good'
    : lastJudgment.grade === 'miss' ? 'miss' : 'extra';
  const hitLabel = config.advanceMode === 'follow'
    ? (followLast?.kind === 'wrong' ? '音高错误' : followLast?.kind === 'partial' ? '等待补齐和弦' : followLast?.kind === 'duplicate' ? '重复按键' : followLast?.advanced ? '已推进' : '等待输入')
    : lastHit === 'good' ? '命中' : lastHit === 'miss' ? '漏拍' : lastHit === 'extra' ? '多击' : '等待输入';
  const hitErrorMs = config.advanceMode === 'follow' ? followLast?.completedTarget?.intervalErrorMs ?? null : lastJudgment?.errorMs ?? null;
  const countdownRemain = status === 'countdown'
    ? countdownToFirstNoteMs(
      session.firstTargetAtMs,
      session.originPerfMs,
      nowTick > 0 ? nowTick : performance.now(),
    )
    : null;
  const countdownSeconds = countdownWholeSeconds(countdownRemain);

  const matchedLabel = config.advanceMode === 'follow'
    ? `${followView?.completed ?? 0} / ${followView?.total ?? 0}`
    : engineTargets ? `${session.liveStats.matched} / ${session.liveStats.total}` : '—';
  const liveHitRate = config.advanceMode === 'follow'
    ? (followReport && followReport.completedTargets > 0 ? Math.round((followReport.standardTargets / followReport.completedTargets) * 100) : null)
    : session.liveStats.total > 0 && session.liveStats.resolved + session.liveStats.extra > 0
      ? Math.round((session.liveStats.matched / session.liveStats.total) * 100)
      : null;

  const sidebar = (
    <aside className="sidebar">
        <div className="brand-row"><div className="brand-mark">R</div><div><div className="brand-name">Rhythm Trainer</div><div className="brand-subtitle">PRACTICE STUDIO</div></div></div>
        <div className="sidebar-section-label">学习</div>
        <nav className="main-nav" aria-label="主导航">
          {NAV_ROUTES.map((navRoute) => (
            <button
              key={navRoute.id}
              className={`nav-item ${route?.id === navRoute.id ? 'active' : ''}`}
              aria-current={route?.id === navRoute.id ? 'page' : undefined}
              aria-label={navRoute.navTitle ?? navRoute.title}
              title={navRoute.title}
              onClick={() => requestNavigation(navRoute.path)}
            >
              <span className="nav-icon">{navRoute.icon}</span>
              <span>{navRoute.navTitle ?? navRoute.title}</span>
              {navRoute.id === 'teaching' && <span className="nav-arrow">›</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-section-label mode-label">练习模式 <span>{visibleModes.length}</span></div>
        <div className="mode-menu">
          {visibleModes.map(mode => <button key={mode.id} className={`mode-item ${config.modeId === mode.id ? 'selected' : ''}`} aria-label={`练习模式：${mode.title}`} title={`${mode.title} · ${mode.subtitle}`} aria-pressed={config.modeId === mode.id} onClick={() => chooseMode(mode.id)}>
            <span className="mode-icon">{mode.icon}</span><span className="mode-copy"><strong>{mode.title}</strong><small>{mode.subtitle}</small></span>{config.modeId === mode.id && <i className="mode-dot" />}
          </button>)}
        </div>
        <div className="sidebar-spacer" />
        <div className="side-note"><span className="note-spark">✦</span><div><strong>教师反馈正在成长</strong><p>先用可解释的规则给出证据,再逐步学习你的长期弱项。</p></div></div>
        <div className="profile-row"><div className="avatar">P</div><div className="profile-text"><strong>练习者</strong><small>个人练习空间</small></div><button className="icon-button" aria-label="设置" title="练习设置" onClick={toggleSettingsPanel}>⚙</button></div>
    </aside>
  );

  const topbar = (
    <header className="topbar">
      <div className="breadcrumb"><span>学习</span><b>/</b><strong>{route?.id === 'workbench' ? currentMode.title : route?.title ?? '页面不存在'}</strong></div>
      <div className="top-actions"><div className={`device-chip ${deviceStatus === 'connected' ? 'device-ok' : ''}`}><span className="device-dot" /><span>{deviceStatus === 'connected' ? 'MIDI 已连接' : deviceStatus === 'connecting' ? 'MIDI 连接中' : deviceStatus === 'error' ? 'MIDI 错误' : 'MIDI 未连接'}</span></div>{portOptions.length > 0 && <select className="port-select" value={selectedPortId ?? ''} onChange={(e) => { setSelectedPortId(e.target.value); connectDevice(e.target.value); }} title="选择要监听的 MIDI 输入端口（只监听选中的一个）">
        {portOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>}<button className="button button-outline button-small" onClick={() => void exportMidiLog()} disabled={deviceStatus !== 'connected'}>导出日志</button><button className="button button-outline button-small" onClick={() => (deviceStatus === 'connected' ? refreshDevices() : connectDevice())} disabled={isConnecting}>{isConnecting ? '连接中…' : deviceStatus === 'connected' ? '刷新设备' : '连接键盘'}</button><button className="avatar mini-avatar">P</button></div>
    </header>
  );

  return (
    <AppShell
      sidebar={sidebar}
      topbar={topbar}
      notice={session.error ? <section className="card error-strip" role="alert"><strong>引擎服务异常</strong><p>{session.error}</p></section> : null}
    >
      <div className="page-content" style={{ display: route?.id === 'workbench' ? undefined : 'none' }}>
          <input
            ref={scoreFileInputRef}
            type="file"
            accept=".musicxml,.xml,application/xml,text/xml"
            className="file-input-hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleScoreFile(file);
            }}
          />
          <input
            ref={libraryReplaceInputRef}
            type="file"
            accept=".musicxml,.xml,application/xml,text/xml"
            className="file-input-hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleLibraryReplaceFile(file);
            }}
          />
          <div className="page-heading"><div><div className="eyebrow">YOUR PRACTICE SPACE</div><h1>今天,稳稳地弹好每一个音。</h1><p>评分由本地 Rust 引擎完成,反馈基于引擎判定与证据。</p></div><div className="heading-actions"><button className="button button-primary" onClick={() => navigate('/teaching')} disabled={!scoreDoc.engine}>✎ 老师带练</button><button className="button button-outline" onClick={() => requestNavigation('/scores')}>曲谱库</button><button className="button button-outline" aria-expanded={showSettings} aria-controls="practice-settings-panel" onClick={toggleSettingsPanel}>⚙ 练习设置</button></div></div>
          {!scoreDoc.engine && (
            <p className="report-warning" role="status">「老师带练」需要一份带语义数据的 MusicXML 曲谱；当前曲谱不可用，请先在曲谱库打开或导入。</p>
          )}

          {showSettings && (
            <section className="settings-panel card" id="practice-settings-panel" aria-label="练习配置">
              <div className="panel-heading">
                <div><h3>练习配置</h3><p>修改后点「保存设置」生效；练习进行中不可修改。</p></div>
                <button type="button" className="icon-button settings-close" aria-label="关闭练习设置" onClick={closeSettingsPanel}>✕</button>
              </div>
              <div className="settings-summary" aria-label="本次练习配置摘要">
                <span>模式 <b>{currentMode.title}</b></span>
                <span><b>{settingsView.config.tempo}</b> BPM</span>
                <span><b>{settingsView.config.hand === 'both' ? '双手' : settingsView.config.hand === 'right' ? '右手' : '左手'}</b></span>
                {settingsView.config.modeId === 'score' && settingsView.config.loopEnabled && (
                  <span>小节 <b>{settingsView.config.loopStartBar}–{settingsView.config.loopEndBar}</b></span>
                )}
                <span>{settingsView.config.advanceMode === 'follow' ? '跟手等待' : '固定时间'}</span>
                <span>{settingsView.metronomeOn ? '节拍器开' : '节拍器关'}</span>
              </div>
              <div className="settings-grid">
                <label className="field"><span>练习速度</span><div className="range-row"><input type="range" min="40" max="160" step="1" value={settingsView.config.tempo} disabled={settingsLocked} onChange={e => updateSettingsDraft('tempo', Number(e.target.value))} /><b>{settingsView.config.tempo} <small>BPM</small></b></div></label>
                <label className="field"><span>练习手 / 分手练习</span><select value={settingsView.config.hand} disabled={settingsLocked || !currentMode.supportsHandSelection} onChange={e => updateSettingsDraft('hand', e.target.value as HandSelection)}><option value="both">双手</option><option value="right">右手</option><option value="left">左手</option></select></label>
                <label className="field"><span>判定档位</span><select value={settingsView.config.profile} disabled={settingsLocked} onChange={e => updateSettingsDraft('profile', e.target.value as JudgmentProfile)}><option value="relaxed">宽松 (±50/100ms)</option><option value="standard">标准 (±30/60ms)</option><option value="strict">严格 (±15/30ms)</option></select></label>
                <label className="field"><span>时值评估 (v0.3)</span><select value={settingsView.config.durationPolicy} disabled={settingsLocked} onChange={e => updateSettingsDraft('durationPolicy', e.target.value as DurationEvaluationPolicy)}><option value="strict-keydown">严格按键时长</option><option value="disabled">只记录不评分</option></select></label>
                <label className="field"><span>反馈时机</span><select value={settingsView.config.feedback} disabled={settingsLocked} onChange={e => updateSettingsDraft('feedback', e.target.value as FeedbackMode)}><option value="live">实时反馈</option><option value="after">结束后分析</option></select></label>
                <label className="field"><span>练习推进</span><select value={systemDuet ? 'timeline' : settingsView.config.advanceMode} disabled={settingsLocked || systemDuet} onChange={e => updateSettingsDraft('advanceMode', e.target.value as 'timeline' | 'follow')}><option value="follow">跟手等待（光标跟着你）</option><option value="timeline">固定时间（自动判定）</option></select></label>
                <div className="field field-wide"><span>识谱辅助（仅显示）</span><div className="hint-toggle-row">
                  <button type="button" className={`toggle ${scoreHints.noteNames ? 'on' : ''}`} aria-pressed={scoreHints.noteNames} onClick={toggleNoteNames}><i />音名提示 {scoreHints.noteNames ? '开' : '关'}</button>
                  <button type="button" className={`toggle ${scoreHints.positionHints ? 'on' : ''}`} aria-pressed={scoreHints.positionHints} onClick={togglePositionHints}><i />线/间提示 {scoreHints.positionHints ? '开' : '关'}</button>
                  <button type="button" className="text-button hint-reset" onClick={() => setHintOverrides({})}>跟随默认</button>
                </div><small className="settings-note">音名：{scoreHints.noteNamesSource === 'default' ? '跟随模式默认' : '手动'} · 线/间：{scoreHints.positionHintsSource === 'default' ? '跟随模式默认' : '手动'}；专业谱面不叠加标注，这些开关只影响点击音符详情与严格模式提示，不改变目标或分数。</small></div>
                <div className="field field-wide"><span>乐谱来源</span><div className="hint-toggle-row">
                  <button type="button" className="button button-outline button-small" disabled={settingsLocked} onClick={requestScoreImport}>导入 MusicXML</button>
                  <button type="button" className="button button-outline button-small" disabled={settingsLocked} onClick={loadLedgerDemo}>谱表外示例</button>
                  <button type="button" className="button button-outline button-small" disabled={settingsLocked} onClick={restoreDefaultScore}>恢复默认乐谱</button>
                </div><small className="settings-note">当前：{scoreDoc.meta.title} · {scoreDoc.notes.length} 个音符 · {scoreDoc.meta.staves === 1 ? '单谱表' : '双谱表'}</small></div>
                <div className="field field-wide" aria-label="谱表手别映射">
                  <span>谱表 → 手别映射（严格计分必需）</span>
                  <div className="hint-toggle-row">
                    {staffMappingDraft.map((entry) => (
                      <label key={entry.staffNumber} className="staff-hand-mapping">
                        谱表 {entry.staffNumber}
                        <select
                          aria-label={`谱表${entry.staffNumber} 手别`}
                          value={entry.hand}
                          disabled={settingsLocked}
                          onChange={(e) => updateStaffMappingDraft(entry.staffNumber, e.target.value as 'left' | 'right')}
                        >
                          <option value="right">右手</option>
                          <option value="left">左手</option>
                        </select>
                      </label>
                    ))}
                    <button
                      type="button"
                      className="button button-outline button-small"
                      disabled={settingsLocked || staffMappingDraft.length === 0}
                      onClick={confirmStaffMapping}
                    >确认手别映射</button>
                  </div>
                  <small className="settings-note">手别只来自你在这里的确认；谱号推断仅用于初始建议，不参与严格计分。多 Part 乐谱按所选 Part 的谱表映射。</small>
                </div>
                <div className="field field-full score-library-field" aria-busy={scoreLibraryBusy}>
                  <span>乐谱库 <b className="score-library-count">{scoreLibrary.length}</b></span>
                  <div className="score-library-row">
                    <select
                      aria-label="选择已保存的乐谱"
                      value={selectedLibraryId}
                      disabled={scoreLibraryBusy || scoreLibrary.length === 0}
                      onChange={event => setSelectedLibraryId(event.target.value)}
                    >
                      {scoreLibrary.length === 0 && <option value="">乐谱库为空</option>}
                      {scoreLibrary.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                    </select>
                    <button type="button" className="button button-outline button-small" disabled={!selectedLibraryEntry || scoreLibraryBusy || settingsLocked} onClick={() => void loadScoreFromLibrary(selectedLibraryId)}>载入</button>
                    <button type="button" className="button button-outline button-small" disabled={!selectedLibraryEntry || scoreLibraryBusy} onClick={() => void renameScoreLibraryEntry()}>重命名</button>
                    <button type="button" className="button button-outline button-small" disabled={!selectedLibraryEntry || scoreLibraryBusy || settingsLocked} onClick={requestLibraryReplace}>替换 XML</button>
                    <button type="button" className="button button-ghost button-small score-library-delete" disabled={!selectedLibraryEntry || scoreLibraryBusy} onClick={() => void removeScoreLibraryEntry()}>删除</button>
                  </div>
                  <small className="settings-note">
                    {activeLibraryEntry ? `当前来自乐谱库：《${activeLibraryEntry.name}》。` : ''}
                    {scoreLibraryBusy
                      ? '正在读取乐谱库…'
                      : scoreLibraryError
                        ? `乐谱库错误：${scoreLibraryError}`
                        : scoreLibrary.length
                          ? `共 ${scoreLibrary.length} 份；按名称选择后点「载入」。`
                          : '还没有保存的乐谱；导入 MusicXML 后会按文件名自动保存。'}
                  </small>
                </div>
                <div className="field field-full take-template-field" aria-busy={takeTemplateBusy}>
                  <span>本次练习 Take <b className="score-library-count">{takeTemplates.length}</b></span>
                  <div className="score-library-row">
                    <select
                      aria-label="选择保存的 Take"
                      value={selectedTakeTemplateId}
                      disabled={takeTemplateBusy || takeTemplates.length === 0}
                      onChange={event => setSelectedTakeTemplateId(event.target.value)}
                    >
                      <option value="">不关联保存的 Take</option>
                      {takeTemplates.map(template => (
                        <option key={template.id} value={template.id}>
                          {template.name}{template.scoreLabel ? ` · ${template.scoreLabel}` : ''}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="button button-outline button-small" disabled={!selectedTakeTemplateId || takeTemplateBusy || settingsLocked} onClick={applyTakeTemplate}>应用</button>
                    <button type="button" className="button button-outline button-small" disabled={takeTemplateBusy || settingsLocked} onClick={() => void saveCurrentAsTakeTemplate()}>保存当前为 Take</button>
                    <button type="button" className="button button-outline button-small" disabled={!selectedTakeTemplateId || takeTemplateBusy || settingsLocked} onClick={() => void renameTakeTemplate()}>重命名</button>
                    <button type="button" className="button button-ghost button-small score-library-delete" disabled={!selectedTakeTemplateId || takeTemplateBusy} onClick={() => void deleteTakeTemplate()}>删除</button>
                  </div>
                  <small className="settings-note">
                    {appliedTakeTemplateId
                      ? `本次记录将关联：${takeTemplates.find(item => item.id === appliedTakeTemplateId)?.name ?? appliedTakeTemplateId}。开始练习后会创建新的 Session/Take，不会覆盖历史。`
                      : '选择并应用一个 Take 后开始练习；每次演奏都会生成新的关联记录，历史不会被覆盖。'}
                  </small>
                  {takeTemplateError && <small className="report-warning">{takeTemplateError}</small>}
                </div>
                {settingsView.config.modeId === 'score' && (
                  <div className="field"><span>只练所选小节（loop）</span><button type="button" className={`toggle ${settingsView.config.loopEnabled ? 'on' : ''}`} aria-pressed={settingsView.config.loopEnabled} disabled={settingsLocked} onClick={() => updateSettingsDraft('loopEnabled', !settingsView.config.loopEnabled)}><i />{settingsView.config.loopEnabled ? '已开启' : '已关闭'}</button></div>
                )}
                {settingsView.config.modeId === 'score' && settingsView.config.loopEnabled && (
                  <label className="field"><span>练习小节范围 (1–{maxBar})</span><div className="range-row">
                    <input type="number" inputMode="numeric" aria-label="循环起始小节" min={1} max={maxBar} value={settingsView.config.loopStartBar} disabled={settingsLocked} onChange={e => updateSettingsDraft('loopStartBar', Math.min(Math.max(1, Number(e.target.value) || 1), settingsView.config.loopEndBar))} />
                    <span aria-hidden="true">–</span>
                    <input type="number" inputMode="numeric" aria-label="循环结束小节" min={1} max={maxBar} value={settingsView.config.loopEndBar} disabled={settingsLocked} onChange={e => updateSettingsDraft('loopEndBar', Math.max(Math.min(maxBar, Number(e.target.value) || maxBar), settingsView.config.loopStartBar))} />
                  </div></label>
                )}
                <div className="field"><span>节拍器</span><button type="button" className={`toggle ${settingsView.metronomeOn ? 'on' : ''}`} aria-pressed={settingsView.metronomeOn} disabled={settingsLocked} onClick={toggleMetronomeDraft}><i />{settingsView.metronomeOn ? '已开启' : '已关闭'}</button></div>
              </div>
              <div className="settings-constraints">
                <p><strong>预备拍：</strong>默认固定 3 秒（按当前 BPM 换算为拍数，例如 40 BPM 为 2 拍）；A2 不提供可配置选项。</p>
                <p><strong>音频输出延迟：</strong>尚未校准（uncalibrated）；时间偏差用于练习反馈，不代表采样级物理精度。</p>
                <p><strong>分手/循环：</strong>它们现在是乐谱跟练的配置项，不再是独立模式；选择单手或开启“只练所选小节”即可。</p>
                <p><strong>小节循环：</strong>当前只练所选范围一次，不跨轮重复；轮次边界仍在后续能力中。</p>
                <p><strong>配置快照：</strong>开始后本轮配置冻结；保存后点开始/再练一次会用当前配置新开一轮，不恢复旧 Take。</p>
                <p><strong>参考播放：</strong>系统伴弹开启时使用固定时间；运行中不修改 BPM。</p>
              </div>
              <div className="settings-actions">
                <small className={`settings-save-state ${settingsSaved ? 'is-saved' : settingsDirty ? 'is-dirty' : ''}`} role="status" aria-live="polite">
                  {settingsSaved ? '已保存，下次打开页面自动恢复。' : settingsDirty ? '有未保存的修改。' : '练习参数需点「保存设置」；识谱辅助与乐谱导入即时生效。'}
                </small>
                <div className="settings-action-buttons">
                  <button type="button" className="button button-ghost settings-cancel" onClick={closeSettingsPanel}>取消</button>
                  <button type="button" className="button button-primary settings-save" onClick={saveSettingsDraft} disabled={settingsLocked || !settingsDirty}>
                    {settingsSaved ? '已保存' : '保存设置'}
                  </button>
                </div>
              </div>
            </section>
          )}

          <section className="session-strip">
            <div className="session-main"><div className="session-art">{currentMode.icon}</div><div className="session-copy"><div className="session-title-row"><h2>{currentMode.title}</h2><span className={`status-pill ${statusClass}`}><i />{statusLabel}</span></div><p>{currentMode.description}</p><div className="session-tags"><span>♩ {config.tempo} BPM</span><span>♬ {config.hand === 'both' ? '双手' : config.hand === 'right' ? '右手' : '左手'}</span>{session.takeTemplateName && <span>Take {session.takeTemplateName}</span>}<span>◉ {config.feedback === 'live' ? '实时反馈' : '结束后分析'}</span><span>{config.advanceMode === 'follow' ? '◉ 光标跟随' : '⏱ 固定时间'}</span><span>♪ 参考 {referenceStatusLabel}{referencePositionLabel ? ` · ${referencePositionLabel}` : ''}</span><span>⌨ {deviceStatus === 'connected' ? `输入 ${deviceHealth}` : 'MIDI 未连接'}</span><span className="uncalibrated-tag">音频延迟未校准</span><span>⚖ {(session.scoringConfig?.judgmentProfile ?? config.profile) === 'strict' ? '严格' : (session.scoringConfig?.judgmentProfile ?? config.profile) === 'relaxed' ? '宽松' : '标准'}判定{session.scoringConfig?.judgmentProfileSource === 'mode-default' ? '（模式默认）' : ''}</span></div></div></div>
            <div className="session-controls"><div className="elapsed"><small>本次练习</small><strong>{formatTime(elapsed)}</strong></div>{prepRemain !== null ? <button className="button button-primary" disabled>准备 {prepRemain}s…</button> : status === 'running' || status === 'countdown' ? <button className="button button-primary" onClick={pausePractice}>Ⅱ 暂停</button> : status === 'paused' ? <button className="button button-primary" onClick={resumePractice}>▶ 继续练习</button> : <button className="button button-primary" onClick={startPractice} disabled={status === 'processing' || starting || settingsDirty}>{status === 'completed' ? '↻ 再练一次' : '▶ 开始练习'}</button>}<button className="button button-ghost" onClick={finishPractice} disabled={status === 'idle' || status === 'completed' || status === 'processing'}>结束</button><button className="button button-ghost" onClick={resetPractice}>重置</button></div>
          </section>
          <p className="calibration-note" role="note">
            音频输出延迟尚未校准（uncalibrated）。当前 onset 偏差适合练习反馈，不应视为采样级精确测量；输出延迟校准在 C2 接入。
          </p>

          <div className="workspace-grid">
            <section className="card score-card"><ScoreViewer
              score={scoreDoc.notes}
              meta={scoreDoc.meta}
              warnings={scoreDoc.warnings}
              activeNoteIds={activeNoteIds}
              hand={config.hand}
              modeId={config.modeId === 'score' && config.loopEnabled ? 'loop' : config.modeId}
              notes={visibleTargetNotes}
              loopStartBar={config.modeId === 'score' && config.loopEnabled ? config.loopStartBar : undefined}
              loopEndBar={config.modeId === 'score' && config.loopEnabled ? config.loopEndBar : undefined}
              showNoteNames={scoreHints.noteNames}
              showPositionHints={scoreHints.positionHints}
              lastInputMidi={lastInputMidi}
              tempo={config.tempo}
              strictAssessment={config.profile === 'strict'}
              sourceXml={scoreDoc.sourceXml}
              engine={scoreDoc.engine}
              followPulse={followPulse}
              systemNoteIds={systemNoteIds}
              userNoteIds={userNoteIds}
              systemDuet={systemDuet}
              onToggleSystemDuet={toggleSystemDuet}
              systemAudio={systemAudio}
              onToggleSystemAudio={toggleSystemAudio}
              prepRemain={prepRemain}
              firstNoteCountdownMs={countdownRemain}
            /></section><div className="score-status-bar score-bottom"><div><span className="small-label">当前目标音</span><strong>{currentTargetLabel}</strong></div><div><span className="small-label">当前输入</span><strong className={pitchMismatch ? 'text-bad' : ''}>{inputNote}</strong></div><div><span className="small-label">最近判定</span><strong>{hitLabel}{hitErrorMs !== null ? ` ${hitErrorMs > 0 ? '+' : ''}${Math.round(hitErrorMs)}ms` : ''}</strong></div>{countdownSeconds !== null && <div><span className="small-label">距离首音</span><strong>{countdownSeconds}</strong></div>}<button className="button button-outline button-small" onClick={() => simulateNote()} disabled={(status !== 'running' && status !== 'countdown') || deviceStatus === 'connected'}>模拟按键</button></div>

            <aside className="right-column"><section className="card feedback-card"><div className="card-heading"><div><div className="eyebrow">LIVE COACH</div><h3>实时反馈</h3></div><span className="live-indicator"><i />LIVE</span></div><div className="feedback-summary"><div className={`feedback-symbol ${lastHit === 'good' ? 'feedback-good' : lastHit !== 'waiting' ? 'feedback-warn' : ''}`}>{lastHit === 'good' ? '✓' : lastHit === 'miss' ? '○' : lastHit === 'extra' ? '−' : '⌁'}</div><div><strong>{lastHit === 'good' ? '这一拍很稳' : lastHit === 'miss' ? '漏掉了这一拍' : lastHit === 'extra' ? '多了一次击打' : '等待你的演奏'}</strong><p>{status === 'countdown' ? '倒数到第一个音,听到预备拍后准备;数字归零就是第一个音的起点。' : status !== 'running' ? '开始练习后,引擎会根据输入事件给出判定。' : lastHit === 'good' ? '时机落在引擎判定窗口内。继续保持。' : '弹奏当前高亮音符,判定会出现在这里。'}</p></div></div><div className="feedback-list">{feedbackItems.slice(0, 4).map(item => <div className="feedback-entry" key={item.id}><i className={`entry-dot tone-${item.tone}`} /><div><strong>{item.title}</strong><p>{item.detail}</p></div></div>)}</div><div className="feedback-footer"><span>节奏判定:Rust 引擎 · 音高:独立提示</span><button onClick={() => addFeedback('判定依据', '节奏评分来自本地引擎的确定性匹配(目标时间表 + 击打时间戳);音高提示只对比目标音集合,不影响节奏成绩。', 'neutral')}>反馈依据 ↗</button></div></section>

              <section className="card quick-card"><div className="card-heading"><div><div className="eyebrow">QUICK INPUT</div><h3>输入与练习状态</h3></div><span className="shortcut-key">MIDI</span></div><div className="device-row"><div className={`device-icon ${deviceStatus === 'connected' ? 'connected' : ''}`}>⌨</div><div className="device-copy"><strong>{deviceName}</strong><small>{deviceStatus === 'connected' ? `正在监听音符按下/抬起 · 输入健康：${deviceHealth}` : deviceStatus === 'connecting' ? '正在打开 Node MIDI 端口…' : deviceStatus === 'error' ? `设备错误：${deviceError ?? '未知'}` : '连接实体键盘，或使用下方模拟按键'}</small></div><button className="text-button" onClick={deviceStatus === 'connected' ? disconnectDevice : () => connectDevice()} disabled={deviceStatus === 'connecting'}>{deviceStatus === 'connecting' ? '连接中…' : deviceStatus === 'connected' ? '断开' : '连接'}</button></div><div className="virtual-keys" aria-label="模拟 MIDI 键盘">{[{note:60,label:'C4',black:false},{note:61,label:'C♯',black:true},{note:62,label:'D4',black:false},{note:63,label:'D♯',black:true},{note:64,label:'E4',black:false},{note:65,label:'F4',black:false},{note:66,label:'F♯',black:true},{note:67,label:'G4',black:false}].map(key => <button key={key.note} className={`virtual-key ${key.black ? 'black-key' : ''}`} onPointerDown={(e) => { e.preventDefault(); if (status === 'running' || status === 'countdown') virtualKeyDown(key.note); }} onPointerUp={() => virtualKeyUp(key.note)} onPointerLeave={() => virtualKeyUp(key.note)} title={`按住 ${key.label}（按下=Note On，松开=Note Off）`} disabled={(status !== 'running' && status !== 'countdown') || deviceStatus === 'connected'}><span>{key.label}</span></button>)}</div><div className="quick-hint">按住琴键再松开（或按 MIDI 键盘）：按下与松开都会送入引擎，用于起音判定与按键时长评估。连接实体设备后模拟按键会禁用，避免同一会话混合输入源。</div>{nodeEvents.length > 0 && (
              <div className="midi-monitor">
                <div className="midi-monitor-title">最近输入（Node MIDI）</div>
                {nodeEvents.map((event) => {
                  const oldest = nodeEvents[nodeEvents.length - 1].capturedAtMonotonicMs;
                  const label = event.noteNumber != null
                    ? noteForMidi(event.noteNumber)
                    : event.controllerNumber != null ? `CC${event.controllerNumber}` : '—';
                  const value = event.velocity ?? event.controllerValue ?? '—';
                  const kind = event.messageType === 'note-on' ? 'Note On'
                    : event.messageType === 'note-off' ? 'Note Off'
                    : event.messageType === 'control-change' ? 'CC' : 'Other';
                  return (
                    <div className="midi-monitor-row" key={`${event.sourceId}-${event.sourceSeq}`}>
                      <span>{kind}</span>
                      <span>{label}</span>
                      <span>v{value}</span>
                      <span>#{event.sourceSeq}</span>
                      <span>{Math.max(0, event.capturedAtMonotonicMs - oldest).toFixed(0)}ms</span>
                    </div>
                  );
                })}
              </div>
            )}</section>
            </aside>
          </div>

          <section className="metrics-grid"><div className="metric-card card"><div className="metric-label">当前进度 <span>◷</span></div><div className="metric-value">{config.advanceMode === 'follow' ? (followView?.completed ?? 0) : engineTargets ? Math.min(session.nextUnmatchedIndex, session.liveStats.total) : 0}<small> / {config.advanceMode === 'follow' ? (followView?.total ?? 0) : engineTargets ? session.liveStats.total : scopedTargetCount}</small></div><div className="progress-track"><div style={{ width: `${config.advanceMode === 'follow' ? (followView?.total ? Math.min(100, (followView.completed / followView.total) * 100) : 0) : engineTargets && session.liveStats.total ? Math.min(100, session.nextUnmatchedIndex / session.liveStats.total * 100) : 0}%` }} /></div><div className="metric-foot">引擎已判定的目标进度</div></div><div className="metric-card card"><div className="metric-label">输入次数 <span>⌁</span></div><div className="metric-value">{events.filter(e => e.type === 'note-on').length}<small> 次</small></div><div className="metric-foot">本次会话采集到的按键</div></div><div className="metric-card card"><div className="metric-label">引擎命中 <span>％</span></div><div className="metric-value">{liveHitRate ?? '—'}<small>{liveHitRate !== null ? '%' : ''}</small></div><div className="metric-foot">实时判定 Perfect+Good / 目标数</div></div><div className="metric-card card"><div className="metric-label">引擎统计 <span>♫</span></div><div className="metric-value metric-note">{matchedLabel}</div><div className="metric-foot">命中 / 目标(漏拍与多击见报告)</div></div></section>

          {config.advanceMode === 'follow' && followReport && (
            <FollowReportPanel
              report={followReport}
              persistence={followPersistence}
              onRetrySave={handleFollowRetrySave}
              retrying={followRetrying}
            />
          )}
          {session.reportPersisted === false && (
            <section className="card error-strip" role="alert">
              <strong>报告已生成但未能保存</strong>
              <p>{session.reportPersistenceError ?? '会话记录持久化失败'}。本轮不会被当作已保存记录；请保留页面并检查本地数据目录后再重试。</p>
              <button
                type="button"
                className="button button-outline button-small"
                onClick={() => { void handleTimelineRetrySave(); }}
              >
                重试保存
              </button>
            </section>
          )}
          {status === 'completed' && config.modeId !== 'free' && config.advanceMode !== 'follow' && !session.report && (
            <section className="card error-strip" role="status">
              <strong>本轮没有可评分报告</strong>
              <p>引擎没有返回可用的最终报告；不会显示 0 分或猜测结果。请检查输入/时钟状态后新开一轮。</p>
            </section>
          )}
          {session.report && (
            <ReportPanel
              report={session.report}
              analysis={session.analysis}
              durations={session.durations}
              scoreV1={session.scoreV1}
              scoreStatus={session.scoreStatus}
              scoringConfig={session.scoringConfig}
              scoreConfigVersion={session.scoreConfigVersion}
              scoreAlgorithmVersion={session.scoreAlgorithmVersion}
              scoreInputNoteCount={session.scoreInputNoteCount}
              scoreUnmappedNoteCount={session.scoreUnmappedNoteCount}
              pauseAdjusted={session.pauseAdjusted}
              sessionId={session.sessionId}
              takeId={session.takeId}
              scoreFingerprint={session.scoreFingerprint}
              activeScoreFingerprint={scoreDoc.engine?.fingerprint ?? null}
              scoreBarCount={session.scoreBarCount ?? scoreDoc.meta.barCount}
              practiceBpm={config.tempo}
              practiceHand={session.hand ?? config.hand}
              retryComparison={session.retryComparison}
              onTeachingRunCreated={(run) => {
                // Point the teaching workspace's recovery entry at the newly
                // created run so「打开老师带练」continues this lesson.
                saveLastRunId(run.runId);
                addFeedback('教学课程已创建', '可在左侧「老师带练」中继续这堂课。', 'success');
              }}
              onNavigateTeaching={() => navigate('/teaching')}
            />
          )}

          <footer className="app-footer"><span>Rhythm Trainer · Frontend 0.6.0</span><span>节奏评分与报告由本地 Rust 内核完成;音高提示为独立维度,不参与节奏成绩。</span></footer>
        </div>

        {route?.id === 'scores' && (
          <ScoreLibraryPage
            activeLibraryId={activeLibraryId}
            onOpenScore={handleOpenLibraryScore}
            onLibraryChanged={() => { void refreshScoreLibrary(); }}
            onActiveScoreRemoved={handleActiveScoreRemoved}
            onBackToWorkbench={() => navigate('/workbench')}
          />
        )}
        {route?.id === 'reader' && (
          <ReaderPage
            doc={scoreDoc}
            activeLibraryId={activeLibraryId}
            restoring={scoreRestoreState === 'loading'}
            onBackToLibrary={() => navigate('/scores')}
            onStartPractice={handleStartPracticeFromReader}
          />
        )}
        {route?.id === 'device' && (
          <DevicePage
            deviceStatus={deviceStatus}
            deviceName={deviceName}
            deviceHealth={deviceHealth}
            deviceError={deviceError}
            portOptions={portOptions}
            selectedPortId={selectedPortId}
            isConnecting={isConnecting}
            nodeEvents={nodeEvents}
            heldNotes={heldDeviceNotes}
            onRefresh={refreshDevices}
            onSelectPort={setSelectedPortId}
            onConnect={() => connectDevice(selectedPortId ?? undefined)}
            onDisconnect={disconnectDevice}
            onBackToWorkbench={() => requestNavigation('/workbench')}
          />
        )}
        {route?.id === 'history' && (
          <div className="page-content">
            <HistoryView
              refreshKey={historyRefresh}
              activeScoreFingerprint={scoreDoc.engine?.fingerprint ?? null}
              onTeachingRunCreated={(run) => {
                // Point the teaching workspace's recovery entry at the newly
                // created run so「打开老师带练」continues this lesson.
                saveLastRunId(run.runId);
                addFeedback('教学课程已创建', '可在左侧「老师带练」中继续这堂课。', 'success');
              }}
              onNavigateTeaching={() => navigate('/teaching')}
            />
          </div>
        )}
        {route?.id === 'profile' && <div className="page-content"><ProfileView refreshKey={historyRefresh} /></div>}
        {route?.id === 'progress' && (
          <div className="page-content progress-page">
            <div className="page-heading">
              <div>
                <div className="eyebrow">PROGRESS</div>
                <h1>学习进度</h1>
                <p>能力画像是基于规则的暂定学习判断，不是能力认证；下面是已保存的每一次 Take。</p>
              </div>
              <div className="heading-actions">
                <button className="button button-primary" onClick={() => navigate('/teaching')}>继续学习</button>
                <button className="button button-outline" onClick={() => navigate('/workbench')}>自由练习</button>
              </div>
            </div>
            <ProfileView refreshKey={historyRefresh} />
            <HistoryView
              refreshKey={historyRefresh}
              activeScoreFingerprint={scoreDoc.engine?.fingerprint ?? null}
              onTeachingRunCreated={(run) => {
                saveLastRunId(run.runId);
                addFeedback('教学课程已创建', '可在「学习」中继续这堂课。', 'success');
              }}
              onNavigateTeaching={() => navigate('/teaching')}
            />
          </div>
        )}
        {route?.id === 'teaching' && (
          <div className="page-content teaching-page">
            <TeachingWorkspace
              score={{
                fingerprint: scoreDoc.engine?.fingerprint ?? null,
                title: scoreDoc.meta.title,
                barCount: scoreDoc.meta.barCount,
                bpm: config.tempo,
                hand: config.hand,
                sourceXml: scoreDoc.sourceXml ?? null,
                engine: scoreDoc.engine ?? null,
                practiceStartBlock: teachingPracticeBlock,
              }}
              takeNotice={teachingTakeNotice}
              inputStatus={deviceStatus}
              onStartPractice={(request) => applyTeachingStepConfig({
                scoreFingerprint: request.scoreFingerprint,
                tempo: request.tempo,
                hand: request.hand,
                loopStartBar: request.loopStartBar,
                loopEndBar: request.loopEndBar,
              })}
              onBackToWorkbench={() => navigate('/workbench')}
            />
          </div>
        )}
        {(!route || !route.enabled) && (
          <RoutePlaceholder
            route={route}
            path={routePath}
            onBack={() => navigate('/workbench')}
          />
        )}
        <LeaveGuardDialog
          open={Boolean(leaveRequest)}
          busy={leaveBusy}
          processing={session.status === 'processing'}
          error={leaveError}
          onStay={handleStayInPractice}
          onFinishAndLeave={handleFinishAndLeave}
        />
    </AppShell>
  );
}
