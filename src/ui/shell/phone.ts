/** Phone layout breakpoint; keep in sync with the `max-width: 640px` rules in CSS. */
export const PHONE_QUERY = '(max-width: 640px)';

/** Subscribes to the phone media query; calls `set` now and on every change. */
export function watchPhone(set: (phone: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(PHONE_QUERY);
  set(mq.matches);
  const on = (e: MediaQueryListEvent) => set(e.matches);
  mq.addEventListener('change', on);
  return () => mq.removeEventListener('change', on);
}
