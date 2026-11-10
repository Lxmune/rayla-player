// Short vibration ticks for touch interactions (long-press, swipe actions,
// pull-to-refresh). No-op where unsupported (desktop, jsdom) or when the user
// turned on reduced motion. FROZEN CONTRACT for the touch agents.

export type HapticKind = 'tick' | 'press' | 'confirm';

const PATTERN: Record<HapticKind, number | number[]> = {
  tick: 8,
  press: 15,
  confirm: [12, 40, 12],
};

export function haptic(kind: HapticKind = 'tick'): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  if (document.documentElement.dataset.motion === 'reduced') return;
  try {
    navigator.vibrate(PATTERN[kind]);
  } catch {
    // Some WebViews throw without the VIBRATE permission; feedback is optional.
  }
}
