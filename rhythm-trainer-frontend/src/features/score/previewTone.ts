let audioContext: AudioContext | null = null;

/**
 * Short, user-gesture-triggered pitch preview for the score header. It uses a
 * plain oscillator only; it is not a sampled piano and never enters scoring.
 */
export function playPreviewTone(midiNote: number): void {
  if (typeof window === 'undefined') return;
  const AudioCtor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return;
  try {
    audioContext ??= new AudioCtor();
    void audioContext.resume();
    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.value = 440 * 2 ** ((midiNote - 69) / 12);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.07, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.6);
  } catch {
    // Audio is a preview affordance; a blocked context must not break practice.
  }
}
