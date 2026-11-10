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

/** Cover drag: 1:1 follow up to a third of the width, rubber-banded beyond. */
export function coverDragOffset(dx: number, width: number): number {
  if (width <= 0) return 0;
  const a = Math.abs(dx);
  const t = width / 3;
  const eased = a <= t ? a : t + (a - t) * 0.35;
  return Math.sign(dx) * Math.min(eased, width * 0.6);
}

/** Which gesture a cover drag is: horizontal skip, vertical close (touch/pen only), or undecided. */
export function decideCoverDrag(dx: number, dy: number, pointerType: string): 'h' | 'v' | 'none' | 'cancel' {
  const ax = Math.abs(dx);
  if (ax > 8 && ax > Math.abs(dy)) return 'h';
  if (dy > 8 && dy > ax * 1.2) return pointerType === 'mouse' ? 'cancel' : 'v';
  if (dy < -8) return 'cancel';
  return 'none';
}

/** Trackpad two-finger swipe: accumulates deltaX; one gesture = one skip (cooldown ends the inertia tail). */
export class WheelSwipe {
  private acc = 0;
  private last = 0;
  private until = 0;
  constructor(
    private readonly threshold = 90,
    private readonly cooldownMs = 600,
    private readonly idleMs = 150,
  ) {}
  /** Returns 'next' for a swipe left (positive deltaX), 'previous' for right, else null. */
  add(deltaX: number, deltaY: number, now: number): 'next' | 'previous' | null {
    if (now < this.until || Math.abs(deltaX) <= Math.abs(deltaY)) return null;
    if (now - this.last > this.idleMs) this.acc = 0;
    this.last = now;
    this.acc += deltaX;
    if (Math.abs(this.acc) < this.threshold) return null;
    const r = this.acc > 0 ? 'next' : 'previous';
    this.acc = 0;
    this.until = now + this.cooldownMs;
    return r;
  }
}

// ---- Cover / track-info carousel (now playing + mini player) ----

export type SkipDir = 'next' | 'previous';

/** Gap between the current cover and its neighbour in the strip, in px. */
export const CAROUSEL_GAP = 16;
/** A release this far (fraction of the strip distance) commits without a flick. */
export const CAROUSEL_COMMIT_FRACTION = 0.25;
/** Velocity (px/ms) against the drag direction that turns a release into a cancel. */
export const CAROUSEL_REVERSE_PX_PER_MS = 0.3;
export const SETTLE_MIN_MS = 140;
export const SETTLE_MAX_MS = 320;
export const SETTLE_DEFAULT_MS = 250;
/** CSS easing used for settle animations (ease-out, slight overshoot-free). */
export const SETTLE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Queue neighbours exactly as the controller's `next()` / `previous()` pick them (ignoring the 3 s restart rule). */
export function neighbourIndices(
  index: number,
  length: number,
  repeat: 'off' | 'all' | 'one',
): { previous: number | null; next: number | null } {
  if (index < 0 || index >= length) return { previous: null, next: null };
  let next: number | null = null;
  if (index + 1 < length) next = index + 1;
  else if (repeat === 'all') next = 0;
  let previous: number | null = null;
  if (index > 0) previous = index - 1;
  else if (repeat === 'all' && length > 1) previous = length - 1;
  return { previous, next: next === index ? null : next };
}

/** Which neighbour a drag of `dx` reveals: dragging left shows the next one. */
export function peekDirection(dx: number): SkipDir | null {
  if (dx < 0) return 'next';
  if (dx > 0) return 'previous';
  return null;
}

/**
 * Strip offset for a drag of `dx`. With a neighbour on that side it follows 1:1 up to
 * `distance` (cover width + gap); without one it rubber-bands.
 */
export function carouselOffset(dx: number, distance: number, hasPrev: boolean, hasNext: boolean): number {
  if (distance <= 0 || dx === 0) return 0;
  const dir = peekDirection(dx);
  const has = dir === 'next' ? hasNext : hasPrev;
  const a = Math.abs(dx);
  const px = has ? Math.min(a, distance) : resist(a, distance * 0.3);
  return Math.sign(dx) * px;
}

/** Release decision: commit past a quarter of the distance or on a flick; reversing velocity cancels. */
export function decideCarousel(
  dx: number,
  velocity: number,
  distance: number,
  hasPrev: boolean,
  hasNext: boolean,
): SkipDir | 'cancel' {
  const dir = peekDirection(dx);
  if (!dir || distance <= 0) return 'cancel';
  if (!(dir === 'next' ? hasNext : hasPrev)) return 'cancel';
  const along = velocity * Math.sign(dx); // px/ms in the drag direction
  if (along <= -CAROUSEL_REVERSE_PX_PER_MS) return 'cancel';
  const a = Math.abs(dx);
  if (along >= FLICK_PX_PER_MS && a > 10) return dir;
  return a >= distance * CAROUSEL_COMMIT_FRACTION ? dir : 'cancel';
}

/** Where the strip settles: the neighbour centred (next: -distance, previous: +distance) or back home. */
export function settleTarget(verdict: SkipDir | 'cancel', distance: number): number {
  if (verdict === 'next') return -distance;
  if (verdict === 'previous') return distance;
  return 0;
}

/** Settle duration: remaining travel at the release speed, clamped; default when nearly still. */
export function settleDuration(from: number, to: number, velocity: number): number {
  const remaining = Math.abs(to - from);
  const v = Math.abs(velocity);
  if (remaining < 1) return 0;
  if (v < 0.05) return SETTLE_DEFAULT_MS;
  return Math.round(Math.min(SETTLE_MAX_MS, Math.max(SETTLE_MIN_MS, remaining / v)));
}

/** 0..1 progress of the strip towards the neighbour (drives the title cross-fade). */
export function carouselProgress(offset: number, distance: number): number {
  return distance > 0 ? Math.min(1, Math.abs(offset) / distance) : 0;
}
