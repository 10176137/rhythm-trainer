/** A held pointer selects immediately. The ensuing click must not select a
 * second time; click-only/keyboard activation remains supported. */
export function bindNoteSelection(host: HTMLElement, select: (event: MouseEvent) => void) {
  let handledPointer = false;
  const down = (event: PointerEvent) => {
    handledPointer = event.button === 0 && event.isPrimary !== false;
    if (handledPointer) select(event);
  };
  const click = (event: MouseEvent) => { if (!handledPointer || event.detail === 0) select(event); handledPointer = false; };
  host.addEventListener('pointerdown', down);
  host.addEventListener('click', click);
  return () => { host.removeEventListener('pointerdown', down); host.removeEventListener('click', click); };
}
