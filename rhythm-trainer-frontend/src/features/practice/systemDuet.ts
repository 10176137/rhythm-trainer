/**
 * System duet playback. This is an audible guide from the engine's target
 * schedule / expected pitches; it never sends input to the scoring pipeline.
 * It shares the workspace AudioContext and the same synthesized piano voice as
 * reference playback, so follow-mode cues cannot drift onto a second clock.
 */
import { primeSharedAudioContext } from '../playback/sharedAudioContext';
import { startPianoVoice, type PianoVoiceHandle } from '../playback/synthPiano';

export class SystemDuetPlayer {
  private ctx: AudioContext | null = null;
  private scheduled: PianoVoiceHandle[] = [];

  /** Must be called from a user gesture (start/toggle click). */
  ensure(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    this.ctx = this.ctx ?? primeSharedAudioContext();
    if (!this.ctx) return null;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Play notes immediately (follow mode: the system demonstrates the target). */
  playNow(midiNotes: readonly number[], durationMs = 550): void {
    const ctx = this.ensure();
    if (!ctx || midiNotes.length === 0) return;
    this.playAt(ctx.currentTime + 0.03, midiNotes, durationMs);
  }

  /** Schedule notes at an absolute performance.now() timestamp. */
  schedule(midiNotes: readonly number[], atPerfMs: number, durationMs = 550): void {
    const ctx = this.ensure();
    if (!ctx || midiNotes.length === 0) return;
    const when = ctx.currentTime + (atPerfMs - performance.now()) / 1000;
    if (when < ctx.currentTime + 0.02) return;
    this.playAt(when, midiNotes, durationMs);
  }

  private playAt(when: number, midiNotes: readonly number[], durationMs: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const duration = Math.max(0.05, Math.min(8, durationMs / 1000));
    const durationSeconds = Math.max(0.05, duration);
    for (const midiNote of midiNotes) {
      try {
        const voice = startPianoVoice(ctx, ctx.destination, midiNote, when, 0.7);
        voice.release(when + durationSeconds);
        this.scheduled.push(voice);
      } catch {
        // One unplayable note must not break the duet.
      }
    }
  }

  stopAll(): void {
    for (const voice of this.scheduled) voice.forceStop();
    this.scheduled = [];
  }

  close(): void {
    this.stopAll();
    // Shared context: do not close it here.
    this.ctx = null;
  }
}
