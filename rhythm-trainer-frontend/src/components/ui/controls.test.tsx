// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AppButton, AppTheme, ChoiceSelect } from './controls';
it('keeps button semantics, disabled actions and refs when using the shared library', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); const root = createRoot(host);
  const click = vi.fn(); const ref = createRef<HTMLButtonElement>();
  try {
    await act(async () => root.render(<AppButton ref={ref} className="button button-primary" disabled onClick={click}>开始</AppButton>));
    expect(ref.current?.tagName).toBe('BUTTON');
    expect(ref.current?.type).toBe('button');
    expect(ref.current?.classList.contains('ant-btn')).toBe(true);
    await act(async () => ref.current?.click()); expect(click).not.toHaveBeenCalled();
    await act(async () => root.render(<AppButton ref={ref} aria-pressed onClick={click}>循环</AppButton>));
    expect(ref.current?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => ref.current?.click()); expect(click).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it('keeps a library dropdown inside a native dialog and sends the selected value', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const previousScroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const change = vi.fn();
  try {
    await act(async () => root.render(<AppTheme><dialog open><ChoiceSelect label="练习推进" value="follow" onValueChange={change}
      options={[{ value: 'follow', label: '跟手' }, { value: 'timeline', label: '固定时间' }]} /></dialog></AppTheme>));
    const trigger = host.querySelector('[role="combobox"]')!;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, which: 40, bubbles: true })));
    const list = host.querySelector('dialog [role="listbox"]');
    expect(list).not.toBeNull();
    const target = [...list!.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === '固定时间')!;
    await act(async () => target.click());
    expect(change).toHaveBeenCalledWith('timeline');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  } finally { await act(async () => root.unmount()); host.remove(); HTMLElement.prototype.scrollIntoView = previousScroll; vi.unstubAllGlobals(); }
});
