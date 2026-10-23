// One AudioContext for the metronome and reference playback. Creating several
// contexts makes pause/resume, clock mapping and all-notes-off impossible to
// reason about, so every audio feature in the practice workspace shares this.

let sharedContext: AudioContext | null = null;

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const webkit = (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return window.AudioContext ?? webkit ?? null;
}

/** Creates the context if needed. Safe to call repeatedly. */
export function getOrCreateSharedAudioContext(): AudioContext | null {
  if (sharedContext) return sharedContext;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    sharedContext = new Ctor();
    return sharedContext;
  } catch {
    return null;
  }
}

/**
 * Must be called from a user gesture. A context that remains suspended after
 * resume is a real failure, not something the caller may ignore.
 */
export async function ensureSharedAudioContext(): Promise<AudioContext> {
  const context = getOrCreateSharedAudioContext();
  if (!context) throw new Error('当前浏览器不支持 Web Audio。');
  if (context.state !== 'running') {
    try {
      await context.resume();
    } catch (error) {
      throw new Error(`音频引擎启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (context.state !== 'running') {
    throw new Error('音频引擎仍处于挂起状态；请在页面中点击一次后重试。');
  }
  return context;
}

/** Synchronous best effort for UI paths that already had a user gesture. */
export function primeSharedAudioContext(): AudioContext | null {
  const context = getOrCreateSharedAudioContext();
  if (context && context.state === 'suspended') void context.resume();
  return context;
}

export function getSharedAudioContext(): AudioContext | null {
  return sharedContext;
}

/** Test/teardown helper. Production code never closes the shared context. */
export function closeSharedAudioContextForTests(): void {
  try { void sharedContext?.close(); } catch { /* best effort */ }
  sharedContext = null;
}
