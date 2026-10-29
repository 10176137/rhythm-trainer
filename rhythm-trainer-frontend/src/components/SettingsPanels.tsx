import type { SettingsPageProps } from './SettingsPage';

export function JudgmentSettingsPanel(props: SettingsPageProps) { return (<section className="card preference-card" id="preferences-judgment" aria-label="判定与反馈偏好">
          <div className="preference-heading"><div><h2>判定与反馈</h2><p>保存后用于接下来的练习。</p></div><span className="preference-badge">需保存</span></div>
          {props.judgment}
          <div className="preference-save-row">
            <span role="status">{props.saved ? '已保存' : props.dirty ? '有未保存的修改，离开此页将放弃。' : '当前偏好已生效。'}</span>
            <div><button type="button" className="button button-ghost" disabled={!props.dirty} onClick={props.onResetDraft}>撤销修改</button>
              <button type="button" className="button button-primary" disabled={props.locked || !props.dirty} onClick={props.onSave}>保存偏好</button></div>
          </div>
        </section>); }

export function DisplaySettingsPanel(props: SettingsPageProps) { return (<section className="card preference-card" id="preferences-display" aria-label="谱面辅助偏好">
          <div className="preference-heading"><div><h2>谱面辅助</h2><p>只影响显示，不改变练习目标或评分。</p></div><span className="preference-badge">自动保存</span></div>
          {props.display}
        </section>); }

export function HandSettingsPanel(props: SettingsPageProps) { return (<section className={`card preference-card${props.focusMapping ? ' needs-attention' : ''}`} id="preferences-hands" aria-label="手别与曲谱设置">
          <div className="preference-heading"><div><h2>手别与曲谱</h2><p>普通钢琴谱使用以下默认规则；特殊编排可以按曲谱覆盖。</p></div><span className="preference-badge">按曲谱记忆</span></div>
          {props.hands}
          <details className="preferences-score-override" open={props.focusMapping || undefined}>
            <summary>自定义当前曲谱的手别</summary>{props.mapping}
          </details>
        </section>); }

export function LibrarySettingsPanel(props: SettingsPageProps) { return (<section className="card preference-card" id="preferences-library" aria-label="曲谱与练习方案">
          <div className="preference-heading"><div><h2>曲谱与练习方案</h2><p>管理曲谱与保存的练习参数，开始演奏时无需重新选择。</p></div></div>
          {props.library}{props.templates}
        </section>); }
