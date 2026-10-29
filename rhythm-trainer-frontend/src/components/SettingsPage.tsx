import { JudgmentSettingsPanel, DisplaySettingsPanel, HandSettingsPanel, LibrarySettingsPanel } from './SettingsPanels';
import { useEffect, useState, type ReactNode } from 'react';

export interface SettingsPageProps {
  judgment: ReactNode;
  display: ReactNode;
  hands: ReactNode;
  mapping: ReactNode;
  library: ReactNode;
  templates: ReactNode;
  notes: ReactNode;
  dirty: boolean;
  saved: boolean;
  locked: boolean;
  focusMapping: boolean;
  onSave: () => void;
  onResetDraft: () => void;
  onBack: () => void;
  onDevices: () => void;
}

export default function SettingsPage(props: SettingsPageProps) {
  const [category, setCategory] = useState('judgment');
  useEffect(() => { if (props.focusMapping) setCategory('hands'); }, [props.focusMapping]);
  return <div className="page-content global-settings-page">
    <header className="page-heading">
      <div><div className="eyebrow">PREFERENCES</div><h1>总设置</h1>
        <p>少改的选项放在这里。演奏时直接使用当前偏好，无需重复配置。</p></div>
      <button type="button" className="button button-outline" onClick={props.onBack}>返回练习</button>
    </header>
    <div className="preferences-layout">
      <nav className="preferences-nav" aria-label="设置分类">
        <button type="button" aria-pressed={category === 'judgment'} onClick={() => setCategory('judgment')}>判定与反馈</button>
        <button type="button" aria-pressed={category === 'display'} onClick={() => setCategory('display')}>谱面辅助</button>
        <button type="button" aria-pressed={category === 'hands'} onClick={() => setCategory('hands')}>手别与曲谱</button>
        <button type="button" aria-pressed={category === 'library'} onClick={() => setCategory('library')}>曲谱与方案</button>
        <button type="button" onClick={props.onDevices}>键盘与设备 <span>↗</span></button>
      </nav>
      <div className="preferences-content">
        {category === 'judgment' && <JudgmentSettingsPanel {...props} />}
        {category === 'display' && <DisplaySettingsPanel {...props} />}
        {category === 'hands' && <HandSettingsPanel {...props} />}
        {category === 'library' && <LibrarySettingsPanel {...props} />}
        <button type="button" className="text-button" onClick={() => setCategory(category === 'help' ? 'judgment' : 'help')}>练习与音频说明</button>
        {category === 'help' && <details open className="preference-help"><summary>练习与音频说明</summary>{props.notes}</details>}
      </div>
    </div>
  </div>;
}
