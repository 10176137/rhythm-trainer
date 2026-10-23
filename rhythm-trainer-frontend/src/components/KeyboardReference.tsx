import { midiToPitchName } from '../features/score/staffMapping';

interface Props {
  midiNote: number;
}

const FIRST_MIDI = 36; // C2
const LAST_MIDI = 83; // B5
const WHITE_KEY_COUNT = 28;
const WIDTH = 580;
const KEY_HEIGHT = 54;
const WHITE_WIDTH = WIDTH / WHITE_KEY_COUNT;
const BLACK_WIDTH = WHITE_WIDTH * 0.62;
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

const allKeys = Array.from({ length: LAST_MIDI - FIRST_MIDI + 1 }, (_, index) => FIRST_MIDI + index);
const whiteKeys = allKeys.filter((midi) => !BLACK_PITCH_CLASSES.has(midi % 12));
const blackKeys = allKeys.filter((midi) => BLACK_PITCH_CLASSES.has(midi % 12));
const whiteIndexByMidi = new Map(whiteKeys.map((midi, index) => [midi, index]));

export default function KeyboardReference({ midiNote }: Props) {
  const noteName = midiToPitchName(midiNote);
  const inRange = midiNote >= FIRST_MIDI && midiNote <= LAST_MIDI;

  return (
    <div className="keyboard-reference">
      <div className="keyboard-reference-head">
        <span>虚拟键盘对照</span>
        <b>{noteName} · MIDI {midiNote}</b>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} 62`}
        role="img"
        aria-label={`虚拟键盘 C2 到 B5，高亮键为 ${noteName}${inRange ? '' : '（超出图示范围）'}`}
      >
        {whiteKeys.map((midi, index) => (
          <rect
            key={`white-${midi}`}
            x={index * WHITE_WIDTH + 0.5}
            y="0.5"
            width={WHITE_WIDTH - 1}
            height={KEY_HEIGHT}
            rx="2.5"
            className={`piano-white${midi === midiNote ? ' is-active' : ''}`}
          />
        ))}
        {blackKeys.map((midi) => {
          const previousWhiteIndex = whiteIndexByMidi.get(midi - 1);
          if (previousWhiteIndex === undefined) return null;
          const x = (previousWhiteIndex + 1) * WHITE_WIDTH - BLACK_WIDTH / 2;
          return (
            <rect
              key={`black-${midi}`}
              x={x}
              y="0"
              width={BLACK_WIDTH}
              height="34"
              rx="2"
              className={`piano-black${midi === midiNote ? ' is-active' : ''}`}
            />
          );
        })}
        {whiteKeys
          .filter((midi) => midi % 12 === 0)
          .map((midi) => {
            const index = whiteIndexByMidi.get(midi) ?? 0;
            return (
              <text
                key={`label-${midi}`}
                x={index * WHITE_WIDTH + WHITE_WIDTH / 2}
                y={KEY_HEIGHT - 5}
                className={`piano-key-label${midi === midiNote ? ' is-active' : ''}`}
                aria-hidden="true"
              >
                {midiToPitchName(midi)}
              </text>
            );
          })}
      </svg>
      <p className="keyboard-reference-note">高亮键对应当前选中音符；黑白键位置与钢琴一致。</p>
    </div>
  );
}
