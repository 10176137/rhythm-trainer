import { useEffect, useRef, type ReactNode } from 'react';

export default function SettingsDialog({ children, onClose, label = '练习设置' }: { children: ReactNode; onClose: () => void; label?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className="settings-dialog" aria-label={label} onCancel={(event) => { event.preventDefault(); onClose(); }}>{children}</dialog>;
}
