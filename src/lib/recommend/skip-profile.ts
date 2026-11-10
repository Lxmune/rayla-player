// What the user skips, as pure data + scoring helpers. No I/O; `now` injected.

export interface SkipRecord {
  /** Track id that was skipped. */
  id: string;
  /** Lower-cased artist names and genre names of the track. */
  artists: string[];
  genres: string[];
  /** Epoch ms. */
  at: number;
  /** Library item kind for dislikes ('MusicArtist' dislikes the artist, not a track). */
  kind?: string;
}

const DAY_MS = 86_400_000;
/** A skip counts half as much after this long. */
export const SKIP_HALF_LIFE_DAYS = 30;
/** Decayed skips of one track at which it is left out of mixes. */
export const TRACK_EXCLUDE_AT = 2;
/** Feature weights never drop below this share because of skips. */
export const MIN_SKIP_FACTOR = 0.5;

export const skipWeight = (at: number, now: number): number =>
  0.5 ** (Math.max(0, now - at) / (SKIP_HALF_LIFE_DAYS * DAY_MS));

/** A dislike counts this many skips in the artist / genre ratios, and never decays for the track itself. */
export const DISLIKE_WEIGHT = 3;
/** Feature weights never drop below this share because of dislikes + skips together. */
export const MIN_DISLIKE_FACTOR = 0.25;

export interface SkipProfile {
  /** Tracks / albums / artists the user marked "Not interested": never recommended again. */
  isDisliked(id: string): boolean;
  /** An artist (lower-cased name) marked "Not interested": none of their tracks are recommended. */
  isArtistDisliked(key: string): boolean;
  /** Tracks skipped at least twice (decayed) recently: keep them out of mixes. */
  isSkipped(trackId: string): boolean;
  /**
   * Multiplier 0.5..1 for a taste feature given how often it was played:
   * skips / (skips + plays) of 0 → 1, of 1 → 0.5.
   */
  factor(kind: 'artist' | 'genre', key: string, plays: number): number;
  readonly size: number;
}

export const NO_SKIPS: SkipProfile = {
  isDisliked: () => false,
  isArtistDisliked: () => false,
  isSkipped: () => false,
  factor: () => 1,
  size: 0,
};

export function buildSkipProfile(
  records: readonly SkipRecord[],
  now: number,
  dislikes: readonly SkipRecord[] = [],
): SkipProfile {
  const tracks = new Map<string, number>();
  const artists = new Map<string, number>();
  const genres = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, w: number) => m.set(k, (m.get(k) ?? 0) + w);
  for (const r of records) {
    const w = skipWeight(r.at, now);
    bump(tracks, r.id, w);
    for (const a of new Set(r.artists)) bump(artists, a, w);
    for (const g of new Set(r.genres)) bump(genres, g, w);
  }
  const disliked = new Set<string>();
  const dislikedArtists = new Set<string>();
  const dArtists = new Map<string, number>();
  const dGenres = new Map<string, number>();
  for (const r of dislikes) {
    disliked.add(r.id);
    if (r.kind === 'MusicArtist' && r.artists[0]) dislikedArtists.add(r.artists[0]);
    const w = DISLIKE_WEIGHT * skipWeight(r.at, now);
    for (const a of new Set(r.artists)) bump(dArtists, a, w);
    for (const g of new Set(r.genres)) bump(dGenres, g, w);
  }
  const ratio = (s: number, plays: number) => (s <= 0 ? 0 : Math.min(1, s / (s + Math.max(0, plays))));
  return {
    size: records.length + dislikes.length,
    isDisliked: (id) => disliked.has(id),
    isArtistDisliked: (k) => dislikedArtists.has(k),
    isSkipped: (id) => disliked.has(id) || (tracks.get(id) ?? 0) >= TRACK_EXCLUDE_AT,
    factor: (kind, key, plays) => {
      const skip = 1 - (1 - MIN_SKIP_FACTOR) * ratio((kind === 'artist' ? artists : genres).get(key) ?? 0, plays);
      const dr = ratio((kind === 'artist' ? dArtists : dGenres).get(key) ?? 0, plays);
      const dislike = 1 - (1 - MIN_DISLIKE_FACTOR / MIN_SKIP_FACTOR) * dr;
      return skip * dislike;
    },
  };
}
