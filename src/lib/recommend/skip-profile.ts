// What the user skips, as pure data + scoring helpers. No I/O; `now` injected.

export interface SkipRecord {
  /** Track id that was skipped. */
  id: string;
  /** Lower-cased artist names and genre names of the track. */
  artists: string[];
  genres: string[];
  /** Epoch ms. */
  at: number;
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

export interface SkipProfile {
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
  isSkipped: () => false,
  factor: () => 1,
  size: 0,
};

export function buildSkipProfile(records: readonly SkipRecord[], now: number): SkipProfile {
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
  return {
    size: records.length,
    isSkipped: (id) => (tracks.get(id) ?? 0) >= TRACK_EXCLUDE_AT,
    factor: (kind, key, plays) => {
      const s = (kind === 'artist' ? artists : genres).get(key) ?? 0;
      if (s <= 0) return 1;
      const ratio = s / (s + Math.max(0, plays));
      return 1 - (1 - MIN_SKIP_FACTOR) * Math.min(1, ratio);
    },
  };
}
