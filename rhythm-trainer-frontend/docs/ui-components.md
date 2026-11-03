# UI components

The application uses Ant Design 6 and Ant Design Icons 6. Official references:
https://ant.design/docs/react/getting-started/
https://ant.design/components/select/

`src/components/ui/controls.tsx` owns the app theme, action-button adapter and
controlled select. Both production and native-shell development entries mount
`AppTheme`. Tests rendering a whole app or library select must do the same.

- Purple accent, neutral surfaces, Chinese locale, 40–44px controls and 10px radius.
- Use `AppButton` for actions, with Ant Design `variant`, `color` and `size` props for
  new code. The adapter translates existing action variants and discards their
  old paint classes. Layout classes remain intact.
- Use `ChoiceSelect` for compact single selections. It portals into the nearest
  native dialog so the menu is not behind the modal or inside inert page content.
- Native dialogs and complex native choice cards/forms remain in place. Cards
  with multiple lines are not converted to single-line action buttons.
- `theme.css` adapts shared layout and touch targets. `performanceToolbar.css`
  contains toolbar layout, not a competing component theme.
- Touch buttons and menu items have a minimum 44px hit target.
- The performance rail keeps tempo, hand, metronome, loop and audition visible.
  Reading/fixed-line mode and progression settings stay in the settings dialog.
  Existing session/config callbacks remain the sole owners of state.

This migration changes presentation only. It does not change score generation,
Rust scoring, MIDI admission or the startup policies. Native forms outside the
performance toolbar retain their native behavior with matching theme styling.

## Immersive controls

The performance header and bottom transport are overlays, initially hidden.
A short tap on blank score space toggles both. They never auto-hide on a timer.
Dragging, scrolling, note picking and operating a control do not toggle them.
Blank taps do not suspend score following; dragging still enters manual browse.
Pausing or completing a round reveals the controls, which can then be hidden
with another blank tap. Tab/Enter also reveal them for keyboard use. Hidden
controls are inert and aria-hidden. Motion follows prefers-reduced-motion.
Visibility lives in usePracticeChrome/AppShell; it does not own session state.

Fixed-line performance requires the explicit Start button. Opening the page,
changing config or selecting a score does not automatically create a Take;
finishing also waits for a new explicit start. Reading performance retains
automatic standby and the correct-first-key trigger.
