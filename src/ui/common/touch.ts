// Touch interaction helpers shared by cards, track rows, menus and sheets.
// Decision logic is kept in pure functions (testable without layout); the
// Svelte actions below only wire pointer events to them.

import { haptic } from './haptics';

export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP = 10;
/** Delay before the "pressing" visual starts, so plain taps never flash it. */
export const PRESSING_DELAY_MS = 120;
export const SWIPE_DECIDE_PX = 8;
export const SWIPE_COMMIT_RATIO = 0.3;
/** A native `contextmenu` this soon after a touch is the WebView's own long-press. */
const NATIVE_CONTEXT_WINDOW = 1500;
/** The click that ends a long-press / swipe is swallowed within this window. */
const CLICK_SUPPRESS_MS = 800;

export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduced') return true;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Phone layout: narrow viewport (bottom sheets, swipe actions). */
export function isPhone(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
}

// ---------- pure gesture logic ----------

export type Axis = 'pending' | 'horizontal' | 'vertical';

/** Decides scroll vs swipe once the finger moved far enough. */
export function decideAxis(dx: number, dy: number): Axis {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < SWIPE_DECIDE_PX) return 'pending';
  return ax > ay * 1.2 ? 'horizontal' : 'vertical';
}

/** Whether a moved finger cancels a pending long-press. */
export function exceedsSlop(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > LONG_PRESS_SLOP;
}

/** Row offset for a finger delta: 1:1 up to the commit point, then rubber-banded. */
export function swipeOffset(dx: number, width: number): number {
  if (width <= 0) return 0;
  const a = Math.abs(dx);
  const t = width * SWIPE_COMMIT_RATIO;
  const eased = a <= t ? a : t + (a - t) * 0.35;
  return Math.sign(dx) * Math.min(eased, width * 0.6);
}

export type SwipeCommit = 'right' | 'left' | null;

export function swipeCommit(dx: number, width: number): SwipeCommit {
  if (width <= 0 || Math.abs(dx) < width * SWIPE_COMMIT_RATIO) return null;
  return dx > 0 ? 'right' : 'left';
}

/** Bottom-sheet follow offset: 1:1 downwards, strongly damped upwards. */
export function sheetOffset(dy: number): number {
  return dy >= 0 ? dy : Math.max(-24, dy * 0.12);
}

/** Dismiss when dragged far enough, or flicked down (`velocity` in px/ms). */
export function shouldDismiss(dy: number, velocity: number, height: number): boolean {
  if (dy <= 0) return false;
  return dy > height * 0.4 || (velocity > 0.6 && dy > 24);
}

// ---------- long press ----------

export interface LongPressOptions {
  /** Called with viewport coordinates when the press (or native long-press menu) fires. */
  onlongpress: (at: { x: number; y: number }) => void;
  enabled?: () => boolean;
}

/** Touch long-press. Swallows the click that follows and dedupes the native `contextmenu`. */
export function longPress(node: HTMLElement, initial: LongPressOptions) {
  let opts = initial;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number; id: number } | null = null;
  let firedAt = 0;
  let lastTouchAt = 0;

  const clear = () => {
    if (timer) clearTimeout(timer);
    if (pressTimer) clearTimeout(pressTimer);
    timer = null;
    pressTimer = null;
    start = null;
    delete node.dataset.pressing;
  };
  const fire = (x: number, y: number) => {
    clear();
    if (Date.now() - firedAt < NATIVE_CONTEXT_WINDOW) return;
    firedAt = Date.now();
    haptic('press');
    opts.onlongpress({ x, y });
  };

  function down(e: PointerEvent) {
    if (e.pointerType !== 'touch' || opts.enabled?.() === false) return;
    lastTouchAt = Date.now();
    clear();
    firedAt = 0;
    const s = { x: e.clientX, y: e.clientY, id: e.pointerId };
    start = s;
    timer = setTimeout(() => fire(s.x, s.y), LONG_PRESS_MS);
    pressTimer = setTimeout(() => {
      node.dataset.pressing = '';
    }, PRESSING_DELAY_MS);
  }
  function move(e: PointerEvent) {
    if (!start || e.pointerId !== start.id) return;
    if (exceedsSlop(e.clientX - start.x, e.clientY - start.y)) clear();
  }
  function click(e: MouseEvent) {
    if (firedAt && Date.now() - firedAt < CLICK_SUPPRESS_MS) {
      e.preventDefault();
      e.stopImmediatePropagation();
      firedAt = Date.now() - NATIVE_CONTEXT_WINDOW; // one click only, keep dedupe expired
    }
  }
  function context(e: MouseEvent) {
    if (opts.enabled?.() === false) return;
    if (Date.now() - lastTouchAt > NATIVE_CONTEXT_WINDOW || lastTouchAt === 0) return; // real mouse
    e.preventDefault();
    e.stopImmediatePropagation();
    fire(e.clientX, e.clientY);
  }

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', clear);
  node.addEventListener('pointercancel', clear);
  node.addEventListener('pointerleave', clear);
  node.addEventListener('scroll', clear, true);
  node.addEventListener('click', click, true);
  node.addEventListener('contextmenu', context, true);
  return {
    update(next: LongPressOptions) {
      opts = next;
    },
    destroy() {
      clear();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', clear);
      node.removeEventListener('pointercancel', clear);
      node.removeEventListener('pointerleave', clear);
      node.removeEventListener('scroll', clear, true);
      node.removeEventListener('click', click, true);
      node.removeEventListener('contextmenu', context, true);
    },
  };
}

// ---------- swipe actions ----------

export interface SwipeOptions {
  onright?: () => void;
  onleft?: () => void;
  enabled?: () => boolean;
}

/**
 * Horizontal swipe on a row. Writes `--swipe-x` (px), `data-swipe` (right|left),
 * `data-armed` and `data-settling` on the node; CSS does the rendering.
 */
export function swipeActions(node: HTMLElement, initial: SwipeOptions) {
  let opts = initial;
  let st: { x: number; y: number; id: number; axis: Axis; width: number; dx: number } | null = null;
  let armed = false;
  let swipedAt = 0;

  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const reset = (settle: boolean) => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    node.style.setProperty('--swipe-x', '0px');
    delete node.dataset.armed;
    armed = false;
    st = null;
    if (settle) {
      // Keep the swiping state while the row springs back, then clear it.
      node.dataset.settling = '';
      settleTimer = setTimeout(() => {
        delete node.dataset.settling;
        delete node.dataset.swiping;
        delete node.dataset.swipe;
      }, 340);
    } else {
      delete node.dataset.settling;
      delete node.dataset.swiping;
      delete node.dataset.swipe;
    }
  };

  function down(e: PointerEvent) {
    if (e.pointerType !== 'touch' || opts.enabled?.() === false) return;
    if (settleTimer) reset(false);
    st = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: 'pending', width: node.clientWidth || 320, dx: 0 };
  }
  function move(e: PointerEvent) {
    if (!st || e.pointerId !== st.id) return;
    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    if (st.axis === 'pending') {
      st.axis = decideAxis(dx, dy);
      if (st.axis === 'horizontal') {
        try {
          node.setPointerCapture(e.pointerId);
        } catch {
          // Capture is a nicety.
        }
        node.dataset.swiping = '';
      }
    }
    if (st.axis !== 'horizontal') return;
    st.dx = dx;
    const side = dx > 0 ? 'right' : 'left';
    const handler = side === 'right' ? opts.onright : opts.onleft;
    const off = handler ? swipeOffset(dx, st.width) : swipeOffset(dx, st.width) * 0.25;
    node.style.setProperty('--swipe-x', `${off}px`);
    node.dataset.swipe = side;
    const nowArmed = handler !== undefined && swipeCommit(dx, st.width) === side;
    if (nowArmed !== armed) {
      armed = nowArmed;
      if (armed) {
        haptic('tick');
        node.dataset.armed = '';
      } else delete node.dataset.armed;
    }
  }
  function up() {
    if (!st) return;
    const s = st;
    if (s.axis === 'horizontal') {
      swipedAt = Date.now();
      const c = swipeCommit(s.dx, s.width);
      reset(true);
      if (c === 'right') opts.onright?.();
      else if (c === 'left') opts.onleft?.();
    } else st = null;
  }
  function cancel() {
    if (st?.axis === 'horizontal') reset(true);
    else st = null;
  }
  function click(e: MouseEvent) {
    if (swipedAt && Date.now() - swipedAt < CLICK_SUPPRESS_MS) {
      e.preventDefault();
      e.stopImmediatePropagation();
      swipedAt = 0;
    }
  }

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', click, true);
  return {
    update(next: SwipeOptions) {
      opts = next;
    },
    destroy() {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('click', click, true);
    },
  };
}

// ---------- bottom-sheet drag ----------

export interface SheetDragOptions {
  /** The element that translates with the finger. */
  target: () => HTMLElement | undefined;
  onclose: () => void;
  enabled?: () => boolean;
}

/** Drag-down-to-dismiss from a handle / header. Capture starts only after real movement so inner buttons still click. */
export function sheetDrag(node: HTMLElement, initial: SheetDragOptions) {
  let opts = initial;
  let st: { y: number; id: number; dragging: boolean; samples: { t: number; y: number }[] } | null = null;

  function down(e: PointerEvent) {
    if (opts.enabled?.() === false) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    st = { y: e.clientY, id: e.pointerId, dragging: false, samples: [{ t: e.timeStamp, y: e.clientY }] };
  }
  function move(e: PointerEvent) {
    const t = opts.target();
    if (!st || e.pointerId !== st.id || !t) return;
    const dy = e.clientY - st.y;
    if (!st.dragging) {
      if (Math.abs(dy) < 6) return;
      st.dragging = true;
      try {
        node.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      t.style.transition = 'none';
    }
    st.samples.push({ t: e.timeStamp, y: e.clientY });
    if (st.samples.length > 6) st.samples.shift();
    t.style.transform = `translateY(${sheetOffset(dy)}px)`;
  }
  function end(e: PointerEvent) {
    const t = opts.target();
    const s = st;
    st = null;
    if (!s || !s.dragging || !t) return;
    const dy = e.clientY - s.y;
    const first = s.samples[0];
    const last = s.samples[s.samples.length - 1];
    const dt = first && last ? last.t - first.t : 0;
    const velocity = dt > 0 && first && last ? (last.y - first.y) / dt : 0;
    if (e.type !== 'pointercancel' && shouldDismiss(dy, velocity, t.offsetHeight || 400)) {
      if (prefersReducedMotion()) {
        opts.onclose();
        return;
      }
      t.style.transition = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)';
      t.style.transform = 'translateY(110%)';
      setTimeout(() => opts.onclose(), 200);
    } else {
      t.style.transition = prefersReducedMotion() ? 'none' : 'transform 280ms cubic-bezier(0.34, 1.56, 0.64, 1)';
      t.style.transform = '';
    }
  }

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  return {
    update(next: SheetDragOptions) {
      opts = next;
    },
    destroy() {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', end);
    },
  };
}

// ---------- staggered entrance ----------

let observer: IntersectionObserver | null = null;

/** Fade/rise once when first scrolled into view; batches stagger. No-op without IntersectionObserver / with reduced motion. */
export function reveal(node: HTMLElement) {
  if (typeof IntersectionObserver === 'undefined' || typeof node.animate !== 'function' || prefersReducedMotion()) {
    return {};
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      let n = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        observer?.unobserve(el);
        const delay = Math.min(n++, 8) * 35;
        el.style.opacity = '';
        el.animate(
          [
            { opacity: 0, transform: 'translateY(12px)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 360, delay, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' },
        );
      }
    },
    { rootMargin: '0px 0px -4% 0px' },
  );
  node.style.opacity = '0';
  observer.observe(node);
  return {
    destroy() {
      observer?.unobserve(node);
      node.style.opacity = '';
    },
  };
}
