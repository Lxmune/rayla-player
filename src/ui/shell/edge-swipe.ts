// Pure maths for the phone edge-swipe-back gesture and the overlay-closing order.

export const EDGE_PX = 20;
export const EDGE_COMMIT_FRACTION = 0.35;
export const EDGE_FLICK_PX_PER_MS = 0.5;

/** Only touches that begin within the left edge strip count (so shelves keep their swipes). */
export function startsAtEdge(clientX: number, left = 0, edge = EDGE_PX): boolean {
  const x = clientX - left;
  return x >= 0 && x <= edge;
}

/** Undecided until the finger moved enough; then horizontal-right = swipe, anything else cancels. */
export function classifyEdgeDrag(dx: number, dy: number): 'swipe' | 'none' | 'cancel' {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 8 && ay < 8) return 'none';
  return dx > 0 && ax > ay * 1.2 ? 'swipe' : 'cancel';
}

/** Page offset while dragging: 1:1, clamped to the width. */
export function edgeOffset(dx: number, width: number): number {
  return Math.max(0, Math.min(dx, width > 0 ? width : dx));
}

/** Velocity-aware commit. */
export function decideEdgeRelease(dx: number, velocity: number, width: number): 'commit' | 'cancel' {
  if (dx <= 0) return 'cancel';
  if (velocity >= EDGE_FLICK_PX_PER_MS && dx > 16) return 'commit';
  return width > 0 && dx >= width * EDGE_COMMIT_FRACTION ? 'commit' : 'cancel';
}

export interface OverlayState {
  menu: boolean;
  sheet: boolean;
  nowPlaying: boolean;
  queue: boolean;
}

export type BackStep = 'menu' | 'sheet' | 'nowPlaying' | 'queue' | 'route';

/** What system Back closes first: topmost overlay (menu, sheet, now playing, queue), then the route. */
export function nextBackStep(s: OverlayState): BackStep {
  if (s.menu) return 'menu';
  if (s.sheet) return 'sheet';
  if (s.nowPlaying) return 'nowPlaying';
  if (s.queue) return 'queue';
  return 'route';
}
