// Search result filters: kind chips, lossless / hi-res and decade, applied locally.

import { isHiRes, isLossless } from '../../lib/smart/rules';
import type { BaseItem, SearchResults } from '../../lib/jellyfin/models';

export type SearchKind = 'all' | 'artists' | 'albums' | 'tracks' | 'playlists';

export interface SearchFilters {
  losslessOnly: boolean;
  hiResOnly: boolean;
  /** Decade start (1990), or null for any. */
  decade: number | null;
}

export const NO_FILTERS: SearchFilters = { losslessOnly: false, hiResOnly: false, decade: null };

export const hasQualityFilter = (f: SearchFilters): boolean => f.losslessOnly || f.hiResOnly;

export function inDecade(item: BaseItem, decade: number | null): boolean {
  if (decade === null) return true;
  const y = item.productionYear;
  return y !== null && y >= decade && y < decade + 10;
}

/** Tracks pass on their own media info. */
export function trackPasses(t: BaseItem, f: SearchFilters): boolean {
  if (f.losslessOnly && !isLossless(t)) return false;
  if (f.hiResOnly && !isHiRes(t)) return false;
  return inDecade(t, f.decade);
}

/**
 * Albums carry no media info, so quality is judged from a sample track per album
 * (`sample`: album id -> a track, when loaded). Albums without a sample are kept
 * until their sample arrives (`pending`), so the list does not flicker empty.
 */
export function albumPasses(a: BaseItem, f: SearchFilters, sample: ReadonlyMap<string, BaseItem | null>): boolean {
  if (!inDecade(a, f.decade)) return false;
  if (!hasQualityFilter(f)) return true;
  const s = sample.get(a.id);
  if (s === undefined) return true;
  if (s === null) return false;
  return (!f.losslessOnly || isLossless(s)) && (!f.hiResOnly || isHiRes(s));
}

/** Album ids whose quality sample is still unknown while a quality filter is on. */
export function pendingSamples(albums: readonly BaseItem[], f: SearchFilters, sample: ReadonlyMap<string, BaseItem | null>): string[] {
  if (!hasQualityFilter(f)) return [];
  return albums.filter((a) => inDecade(a, f.decade) && !sample.has(a.id)).map((a) => a.id);
}

/** Artists have no year or quality: they are hidden while a decade / quality filter is on. */
export function applyFilters(
  r: SearchResults,
  playlists: readonly BaseItem[],
  f: SearchFilters,
  sample: ReadonlyMap<string, BaseItem | null>,
): SearchResults & { playlists: BaseItem[] } {
  const narrowing = hasQualityFilter(f) || f.decade !== null;
  return {
    artists: narrowing ? [] : r.artists,
    albums: r.albums.filter((a) => albumPasses(a, f, sample)),
    tracks: r.tracks.filter((t) => trackPasses(t, f)),
    playlists: narrowing ? [] : [...playlists],
  };
}

/** Case-insensitive substring match on playlist names. */
export function matchPlaylists(all: readonly BaseItem[], term: string): BaseItem[] {
  const q = term.trim().toLowerCase();
  return q === '' ? [] : all.filter((p) => p.name.toLowerCase().includes(q));
}

/** Decades offered by the filter. */
export const DECADES: readonly number[] = [2020, 2010, 2000, 1990, 1980, 1970, 1960];

/** Best match: exact / prefix name match, else the first artist, else the first album. */
export function topResult(r: SearchResults & { playlists?: BaseItem[] }, term: string): BaseItem | null {
  const q = term.trim().toLowerCase();
  const named = [...r.artists, ...r.albums, ...(r.playlists ?? [])];
  return (
    named.find((i) => i.name.toLowerCase() === q) ??
    named.find((i) => i.name.toLowerCase().startsWith(q)) ??
    r.artists[0] ??
    r.albums[0] ??
    r.playlists?.[0] ??
    null
  );
}
