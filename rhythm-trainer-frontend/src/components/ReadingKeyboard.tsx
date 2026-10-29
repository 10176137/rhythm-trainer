// 81-key visual keyboard for the note-reading pages. Feedback only: it shows
// input hits/misses and accepts clicks as simulator input when no device is
// connected. It never pre-highlights targets (task spec §5.1).

import { BLACK_PITCH_CLASSES, READING_KEY_HIGH, READING_KEY_LOW, spelledLabel } from '../features/reading/readingKeys';

export type ReadingKeyState = 'idle' | 'hit' | 'wrong' | 'pressed';

interface Props {
  /** midi -> state for the current frame. */
  states: ReadonlyMap<number, ReadingKeyState>;
  /** Simulator input; omitted (keys disabled) when a device is connected. */
  onPress?: (midi: number) => void;
  onRelease?: (midi: number) => void;
  disabled?: boolean;
  /** Key signature for key names: match the session score's spelling side. */
  fifths?: number;
}

const ALL_KEYS = Array.from(
  { length: READING_KEY_HIGH - READING_KEY_LOW + 1 },
  (_, index) => READING_KEY_LOW + index,
);
const WHITE_KEYS = ALL_KEYS.filter((midi) => !BLACK_PITCH_CLASSES.has(midi % 12));
const BLACK_KEYS = ALL_KEYS.filter((midi) => BLACK_PITCH_CLASSES.has(midi % 12));
const WHITE_INDEX = new Map(WHITE_KEYS.map((midi, index) => [midi, index]));
/** Label C-pitch classes of each octave under the keyboard. */
const OCTAVE_STARTS = WHITE_KEYS.filter((midi) => midi % 12 === 0);

const WHITE_KEY_PCT = 100 / WHITE_KEYS.length;
const BLACK_KEY_PCT = WHITE_KEY_PCT * 0.62;

export default function ReadingKeyboard({ states, onPress, onRelease, disabled = false, fifths = 0 }: Props) {
  const label = (midi: number) => spelledLabel(midi, fifths);
  return (
    <div className={`reading-keyboard${disabled ? ' disabled' : ''}`} aria-label="81 键键盘反馈">
      <div className="reading-keyboard-strip">
        {WHITE_KEYS.map((midi) => {
          const state = states.get(midi) ?? 'idle';
          return (
            <button
              key={`w-${midi}`}
              type="button"
              className={`rk-white rk-${state}`}
              disabled={disabled}
              aria-label={`${label(midi)}`}
              title={label(midi)}
              onPointerDown={(event) => { event.preventDefault(); onPress?.(midi); }}
              onPointerUp={() => onRelease?.(midi)}
              onPointerLeave={() => onRelease?.(midi)}
            >
              {midi % 12 === 0 && <span>{label(midi)}</span>}
            </button>
          );
        })}
        {BLACK_KEYS.map((midi) => {
          const anchor = WHITE_INDEX.get(midi - 1);
          if (anchor === undefined) return null;
          const state = states.get(midi) ?? 'idle';
          return (
            <button
              key={`b-${midi}`}
              type="button"
              className={`rk-black rk-${state}`}
              style={{
                left: `calc(${WHITE_KEY_PCT}% * ${anchor + 1} - ${BLACK_KEY_PCT / 2}%)`,
                width: `${BLACK_KEY_PCT}%`,
              }}
              disabled={disabled}
              aria-label={label(midi)}
              title={label(midi)}
              onPointerDown={(event) => { event.preventDefault(); onPress?.(midi); }}
              onPointerUp={() => onRelease?.(midi)}
              onPointerLeave={() => onRelease?.(midi)}
            />
          );
        })}
      </div>
      <div className="reading-keyboard-scale">
        {OCTAVE_STARTS.map((midi) => (
          <span key={`oct-${midi}`} style={{ left: `calc(${WHITE_KEY_PCT}% * ${WHITE_INDEX.get(midi)} + 2px)` }}>
            {label(midi)}
          </span>
        ))}
      </div>
    </div>
  );
}
