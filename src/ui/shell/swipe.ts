// Gesture classification for the floating mini player.

export type SwipeResult = 'up' | 'left' | 'right' | 'tap' | 'none';

export const SWIPE_UP_PX = 40;
export const SWIPE_SIDE_PX = 60;
const TAP_PX = 10;

/** Maps a pointer drag (end minus start) to a gesture. */
export function classifySwipe(dx: number, dy: number): SwipeResult {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < TAP_PX && ay < TAP_PX) return 'tap';
  if (ay > ax) return dy <= -SWIPE_UP_PX ? 'up' : 'none';
  if (ax >= SWIPE_SIDE_PX) return dx < 0 ? 'left' : 'right';
  return 'none';
}

import type { BaseItem } from '../../lib/jellyfin/models';
import type { JellyfinClient } from '../../lib/jellyfin/client';
import { preloadArtwork, preloadBackdrop } from '../common/image-cache';

/** Decodes covers (at each of `sizes`) and backdrops for the neighbouring queue entries. */
export function preloadNeighbours(
  client: JellyfinClient | null,
  items: readonly (BaseItem | null | undefined)[],
  sizes: readonly number[],
): void {
  if (!client) return;
  for (const it of items) {
    if (!it) continue;
    for (const s of sizes) preloadArtwork(client, it, s);
    preloadBackdrop(client, it);
  }
}
