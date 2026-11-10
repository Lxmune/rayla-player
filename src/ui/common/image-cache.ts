// Decoded-image cache. Swapping an <img> to a URL that isn't decoded yet shows
// whatever is behind it for a frame or more (the placeholder, the background);
// covers instead keep the previous image until the next one is decoded, and
// neighbours (next / previous track) are decoded ahead so a swipe swaps instantly.

import { imageItemId, type BaseItem } from '../../lib/jellyfin/models';
import type { JellyfinClient } from '../../lib/jellyfin/client';

export interface ImageSource {
  src: string;
  srcset?: string;
}

/** Same URLs `Artwork` requests for `item` at `size` CSS px (2x for dense screens, 1x candidate). */
export function artworkSource(client: JellyfinClient | null, item: BaseItem, size: number): ImageSource | null {
  if (!client) return null;
  const tag = item.primaryImageTag ?? item.albumPrimaryImageTag;
  const url = (w: number) => client.imageUrl(imageItemId(item), { maxWidth: Math.round(w), tag });
  const src = url(size * 2);
  return { src, srcset: `${url(size)} 1x, ${src} 2x` };
}

/** Small blurred-backdrop URL (see Backdrop.svelte). */
export function backdropSource(client: JellyfinClient | null, item: BaseItem): ImageSource | null {
  if (!client) return null;
  const tag = item.primaryImageTag ?? item.albumPrimaryImageTag;
  return { src: client.imageUrl(imageItemId(item), { maxWidth: 160, tag }) };
}

const MAX_ENTRIES = 120;
/** Key → resolves true once decoded (false on error). Insertion order = age. */
const cache = new Map<string, Promise<boolean>>();
const done = new Set<string>();

const keyOf = (s: ImageSource) => `${s.src}|${s.srcset ?? ''}`;

/** True when `s` is known to be decoded (a swap to it paints in the same frame). */
export function isDecoded(s: ImageSource): boolean {
  return done.has(keyOf(s));
}

/**
 * Loads and decodes `s` off-screen (browser picks the same srcset candidate as an <img>).
 * Resolves true when decoded, false on failure or when images can't load (tests).
 */
export function preloadImage(s: ImageSource): Promise<boolean> {
  const key = keyOf(s);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // refresh age
    cache.set(key, hit);
    return hit;
  }
  if (typeof Image === 'undefined') return Promise.resolve(false);
  const img = new Image();
  img.decoding = 'async';
  if (s.srcset) img.srcset = s.srcset;
  img.src = s.src;
  const p: Promise<boolean> =
    typeof img.decode === 'function'
      ? img.decode().then(
          () => true,
          () => false,
        )
      : new Promise((resolve) => {
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
        });
  const tracked = p.then((ok) => {
    if (ok) done.add(key);
    else cache.delete(key); // retry next time
    return ok;
  });
  cache.set(key, tracked);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
    done.delete(oldest);
  }
  return tracked;
}

/** Decodes the cover `Artwork` will show for `item` at `size`. Fire and forget. */
export function preloadArtwork(client: JellyfinClient | null, item: BaseItem | null, size: number): void {
  const s = item ? artworkSource(client, item, size) : null;
  if (s) void preloadImage(s);
}

/** Decodes the backdrop for `item`. Fire and forget. */
export function preloadBackdrop(client: JellyfinClient | null, item: BaseItem | null): void {
  const s = item ? backdropSource(client, item) : null;
  if (s) void preloadImage(s);
}

/** Test seam. */
export function resetImageCache(): void {
  cache.clear();
  done.clear();
}
