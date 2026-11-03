import { useState } from 'react';
import { getInstrument, saveInstrument, type InstrumentId } from '../features/playback/instruments';
import { INSTRUMENTS, instrumentDefinition } from '../features/playback/instrumentCatalog';
export default function InstrumentSelect({ disabled = false, onChange }: { disabled?: boolean; onChange?: () => void }) {
  const [instrument, setInstrument] = useState(getInstrument);
  return <label className="field"><span>播放音色</span><select aria-label="播放音色" disabled={disabled} value={instrument} onChange={e => {
    const id = e.target.value as InstrumentId; saveInstrument(id); setInstrument(id); onChange?.();
  }}>{INSTRUMENTS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><small>{instrumentDefinition(instrument).description}</small></label>;
}
