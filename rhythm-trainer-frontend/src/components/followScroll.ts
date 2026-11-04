export interface SystemBounds {
  top: number;
  bottom: number;
}

export interface ViewportBounds {
  top: number;
  bottom: number;
}

/**
 * Whether an explicit follow signal should scroll the score pane.
 *
 * A system that is already fully visible must not be re-aligned. On a note tap
 * the follow signal fires while the target is on screen, and re-aligning it
 * pulls the first staff of the system under the fixed performance toolbar —
 * the page appears to jump up and then back down when the pane resets.
 */
export function needsFollowScroll(system: SystemBounds, viewport: ViewportBounds, margin: number): boolean {
  const top = viewport.top + margin;
  const bottom = viewport.bottom - margin;
  return system.top < top || system.bottom > bottom;
}
