// Filtering, sorting and album grouping of the downloaded tracks (pure).

import type { DownloadEntry } from '../../lib/downloads/store.svelte';

export type DownloadSort = 'recent' | 'name' | 'artist';

export interface DownloadGroup {
  key: string;
  album: string;
  artist: string;
  entries: DownloadEntry[];
  bytes: number;
}

export const artistOf = (e: DownloadEntry): string => e.item.artists[0] ?? e.item.albumArtist ?? '';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Entries whose title, artist or album contain every word of `query`. */
export function filterEntries(entries: DownloadEntry[], query: string): DownloadEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries;
  return entries.filter((e) => {
    const hay = `${e.item.name} ${artistOf(e)} ${e.item.album ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const byRecent = (a: DownloadEntry, b: DownloadEntry) => b.addedAt.localeCompare(a.addedAt);
const byAlbumOrder = (a: DownloadEntry, b: DownloadEntry) =>
  (a.item.parentIndexNumber ?? 0) - (b.item.parentIndexNumber ?? 0) ||
  (a.item.indexNumber ?? 0) - (b.item.indexNumber ?? 0) ||
  byRecent(a, b);

export function sortEntries(entries: DownloadEntry[], sort: DownloadSort): DownloadEntry[] {
  const list = [...entries];
  if (sort === 'name') return list.sort((a, b) => collator.compare(a.item.name, b.item.name) || byRecent(a, b));
  if (sort === 'artist')
    return list.sort(
      (a, b) =>
        collator.compare(artistOf(a), artistOf(b)) ||
        collator.compare(a.item.album ?? '', b.item.album ?? '') ||
        byAlbumOrder(a, b),
    );
  return list.sort(byRecent);
}

/** Groups by album; groups follow `sort`, tracks inside keep album order. */
export function groupEntries(entries: DownloadEntry[], sort: DownloadSort): DownloadGroup[] {
  const map = new Map<string, DownloadGroup>();
  for (const e of sortEntries(entries, sort)) {
    const key = e.item.albumId ?? e.item.album ?? '';
    let g = map.get(key);
    if (!g) {
      g = { key, album: e.item.album ?? 'Unknown album', artist: e.item.albumArtist ?? artistOf(e), entries: [], bytes: 0 };
      map.set(key, g);
    }
    g.entries.push(e);
    g.bytes += e.bytes;
  }
  const groups = [...map.values()];
  for (const g of groups) g.entries.sort(byAlbumOrder);
  return groups;
}

export const trackCount = (n: number) => `${n} ${n === 1 ? 'track' : 'tracks'}`;
