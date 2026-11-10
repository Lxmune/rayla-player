// Pure helpers for touch drag-to-reorder lists (queue panel). Coordinates are
// in the scroller's content space so they stay valid while auto-scrolling.

/** Index of the row the dragged centre is over; clamps above / below the list. */
export function targetIndex(center: number, tops: number[], heights: number[]): number {
  if (tops.length === 0) return -1;
  if (center < tops[0]!) return 0;
  for (let i = 0; i < tops.length; i++) {
    if (center < tops[i]! + heights[i]!) return i;
  }
  return tops.length - 1;
}

/** Vertical offset a non-dragged row takes to make room, given the move from -> to. */
export function shiftFor(j: number, from: number, to: number, size: number): number {
  if (j === from) return 0;
  if (from < to && j > from && j <= to) return -size;
  if (from > to && j >= to && j < from) return size;
  return 0;
}

/** Scroll speed (px/frame, signed) when the finger is near the top / bottom edge of the viewport. */
export function edgeScroll(y: number, top: number, bottom: number, zone = 72, max = 16): number {
  if (y < top + zone) return -Math.min(max, ((top + zone - y) / zone) * max);
  if (y > bottom - zone) return Math.min(max, ((y - (bottom - zone)) / zone) * max);
  return 0;
}
