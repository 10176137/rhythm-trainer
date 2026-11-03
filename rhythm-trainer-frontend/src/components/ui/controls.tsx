import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Button, ConfigProvider, Select, type ButtonProps } from 'antd';
import zhCN from 'antd/locale/zh_CN';

export function AppTheme({ children }: { children: ReactNode }) {
  return <ConfigProvider locale={zhCN} componentSize="large" button={{ autoInsertSpace: false }} theme={{
    token: { colorPrimary: '#6257d7', colorText: '#252d3c', colorTextSecondary: '#737b8c',
      colorBorder: '#e2e5ed', colorBgLayout: '#f7f8fb', borderRadius: 10,
      controlHeight: 40, controlHeightLG: 44, fontSize: 14,
      fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" },
    components: { Button: { primaryShadow: '0 3px 8px #6257d71a' }, Select: { optionHeight: 44 } },
  }}><div className="trainer-theme">{children}</div></ConfigProvider>;
}

type AppButtonProps = Omit<ButtonProps, 'type' | 'htmlType'> & {
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type'];
  emphasis?: ButtonProps['type'];
};
/** Keep native button semantics and callbacks; translate legacy action styles
 * into Ant Design variants without retaining the old paint classes. */
export const AppButton = forwardRef<HTMLButtonElement, AppButtonProps>(function AppButton({ className = '', variant, color, size = 'large', type = 'button', emphasis, ...props }, ref) {
  const classes = className.split(/\s+/);
  const primary = classes.includes('primary') || classes.includes('button-primary');
  const quiet = classes.some(value => ['ghost', 'button-ghost', 'text-button'].includes(value));
  const selected = props['aria-pressed'] === true || props['aria-checked'] === true || classes.includes('on') || classes.includes('active');
  const layout = classes.filter(value => !['pt-btn', 'button', 'primary', 'ghost', 'button-primary', 'button-outline', 'button-ghost', 'text-button', 'on', 'active'].includes(value)).join(' ');
  return <Button autoInsertSpace={false} {...props} ref={instance => {
    const element = instance as HTMLButtonElement | null;
    if (typeof ref === 'function') ref(element); else if (ref) ref.current = element;
  }} htmlType={type} type={emphasis ?? (primary ? 'primary' : quiet && !selected ? 'text' : 'default')}
    size={size} variant={variant ?? (selected ? 'filled' : undefined)} color={color ?? (selected ? 'primary' : undefined)} className={`ui-button ${layout}`} />;
});

export function ChoiceSelect({ label, value, disabled, onValueChange, options }: {
  label: string; value: string; disabled?: boolean; onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return <Select aria-label={label} size="large" value={value} disabled={disabled} onChange={next => onValueChange(next)}
    options={[...options]} virtual={false} showSearch={false} className="ui-select"
    classNames={{ popup: { root: 'trainer-select-popup' } }}
    // Keep menus in the native dialog's top layer, not the inert page body.
    getPopupContainer={trigger => trigger.closest('dialog') ?? trigger.parentElement ?? document.body} />;
}
