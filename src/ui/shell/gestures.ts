// Pure maths for the touch gestures (sheet drag, mini-player swipe, pull to refresh).
// Kept free of DOM so it is unit-testable; components feed it pointer deltas.

export const CLOSE_FRACTION = 0.25;
export const FLICK_PX_PER_MS = 0.6;
export const PULL_TRIGGER_PX = 70;
export const PULL_MAX_PX = 120;

export type Release = 'commit' | 'cancel';

/** Decides whether a vertical drag of `dist` px (toward the commit direction) completes. */
export function decideRelease(dist: number, velocity: number, size: number): Release {
  if (dist <= 0) return 'cancel';
  if (velocity >= FLICK_PX_PER_MS && dist > 10) return 'commit';
  return size > 0 && dist >= size * CLOSE_FRACTION ? 'commit' : 'cancel';
}

/** True once a drag has crossed the commit threshold (used to fire the tick haptic once). */
export function pastThreshold(dist: number, size: number): boolean {
  return size > 0 && dist >= size * CLOSE_FRACTION;
}

/** Visual transform for a sheet being dragged down: translate, scale and opacity. */
export function sheetDragStyle(dy: number, height: number): { y: number; scale: number; opacity: number } {
  const y = Math.max(0, dy);
  const p = height > 0 ? Math.min(1, y / height) : 0;
  return { y, scale: 1 - p * 0.06, opacity: 1 - p * 0.5 };
}

/** Rubber-band resistance: approaches `max` asymptotically. */
export function resist(dist: number, max = PULL_MAX_PX): number {
  if (dist <= 0) return 0;
  return max * (1 - Math.exp(-dist / max)) ;
}

export interface PullState {
  /** Displayed pull offset (after resistance). */
  offset: number;
  /** 0..1 progress to the trigger. */
  progress: number;
  armed: boolean;
}

export function pullState(rawDy: number): PullState {
  const offset = resist(rawDy);
  return { offset, progress: Math.min(1, offset / PULL_TRIGGER_PX), armed: offset >= PULL_TRIGGER_PX };
}

/** A pull only starts when the scroller is at the top and the finger moves down, mostly vertically. */
export function shouldStartPull(scrollTop: number, dx: number, dy: number): boolean {
  return scrollTop <= 0 && dy > 6 && dy > Math.abs(dx) * 1.2;
}

/** Horizontal mini-player swipe: commit past 25% of the width or on a flick. */
export function decideSkip(dx: number, velocity: number, width: number): 'next' | 'previous' | 'cancel' {
  const r = decideRelease(Math.abs(dx), velocity, width);
  if (r === 'cancel') return 'cancel';
  return dx < 0 ? 'next' : 'previous';
}

/** Tracks recent pointer samples to estimate release velocity (px/ms, signed). */
export class VelocityTracker {
  private samples: { t: number; v: number }[] = [];
  add(t: number, v: number): void {
    this.samples.push({ t, v });
    if (this.samples.length > 6) this.samples.shift();
  }
  get(): number {
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    if (!a || !b || b.t === a.t) return 0;
    return (b.v - a.v) / (b.t - a.t);
  }
  reset(): void {
    this.samples = [];
  }
}

/** Remembers scroll offsets per stack depth so back restores the page's position. */
export class ScrollMemory {
  private map = new Map<number, number>();
  save(depth: number, top: number): void {
    this.map.set(depth, top);
  }
  take(depth: number): number {
    return this.map.get(depth) ?? 0;
  }
  clearFrom(depth: number): void {
    for (const k of [...this.map.keys()]) if (k >= depth) this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

/** Collapsing toolbar: hide on a sufficient downward scroll, show on any upward scroll. */
export function nextChipsHidden(prevTop: number, top: number, hidden: boolean): boolean {
  const d = top - prevTop;
  if (top <= 8) return false;
  if (d > 6) return true;
  if (d < -4) return false;
  return hidden;
}
