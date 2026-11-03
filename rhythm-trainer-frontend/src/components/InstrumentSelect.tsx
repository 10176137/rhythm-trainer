import { useState } from 'react';
import { getInstrument, saveInstrument, type InstrumentId } from '../features/playback/instruments';
export default function InstrumentSelect({ disabled = false, onChange }: { disabled?: boolean; onChange?: () => void }) {
  const [instrument, setInstrument] = useState(getInstrument);
  return <label className="field"><span>播放音色</span><select aria-label="播放音色" disabled={disabled} value={instrument} onChange={e => {
    const id = e.target.value as InstrumentId; saveInstrument(id); setInstrument(id); onChange?.();
  }}><option value="grand">采样大钢琴 · Salamander</option><option value="electric">柔和合成琴</option></select></label>;
}
