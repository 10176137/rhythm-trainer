import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

/** Root crash guard: a render error shows a recoverable card instead of a blank page. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: 640, margin: '80px auto', padding: 24 }}>
          <div className="card error-strip">
            <strong>界面发生错误，已停止渲染以免数据错乱</strong>
            <p>{this.state.error.message}</p>
            <p className="report-footnote">练习报告若未保存，重新整理后会遗失；引擎服务的历史记录不受影响。</p>
            <button className="button button-primary" onClick={() => { this.setState({ error: null }); location.reload(); }}>重新载入页面</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
