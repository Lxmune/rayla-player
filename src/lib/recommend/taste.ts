// Taste profile and scoring for recommendations. Pure functions: no I/O, `now` injected.

import type { BaseItem, NameId } from '../jellyfin/models';

/** One weighted feature (genre, tag or artist), 0..1 after normalising. */
export interface Feature {
  key: string;
  label: string;
  /** Server id when known (genre / artist ids are needed to query candidates). */
  id: string;
  weight: number;
}

export interface Taste {
  genres: Map<string, Feature>;
  tags: Map<string, Feature>;
  artists: Map<string, Feature>;
  /** Album id → total plays of its tracks in the history. */
  albumPlays: Map<string, number>;
  /** Track id → play count. */
  trackPlays: Map<string, number>;
  /** Number of distinct tracks the profile was built from. */
  size: number;
}

export type ReasonKind = 'genre' | 'tag' | 'artist' | 'similar';

export interface Scored {
  item: BaseItem;
  score: number;
  reason: { kind: ReasonKind; label: string };
}

const DAY_MS = 86_400_000;
/** Plays lose half their weight every 45 days since the last play. */
const HALF_LIFE_DAYS = 45;
/** Old favourites never drop below this share of their weight. */
const RECENCY_FLOOR = 0.35;

const keyOf = (s: string) => s.trim().toLowerCase();

/** Weight of one track: diminishing returns on play count, decayed by time since its last play. */
export function playWeight(item: BaseItem, now: number): number {
  const plays = Math.max(1, item.playCount);
  const last = item.lastPlayed === null ? NaN : Date.parse(item.lastPlayed);
  const ageDays = Number.isNaN(last) ? Infinity : Math.max(0, (now - last) / DAY_MS);
  const recency = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * 0.5 ** (ageDays / HALF_LIFE_DAYS);
  return Math.log2(1 + plays) * recency;
}

function add(map: Map<string, Feature>, label: string, id: string, w: number) {
  const key = keyOf(label);
  if (key === '') return;
  const f = map.get(key);
  if (f) {
    f.weight += w;
    if (f.id === '' && id !== '') f.id = id;
  } else map.set(key, { key, label: label.trim(), id, weight: w });
}

function normalise(map: Map<string, Feature>) {
  let max = 0;
  for (const f of map.values()) max = Math.max(max, f.weight);
  if (max > 0) for (const f of map.values()) f.weight /= max;
}

/** Credited artists of an item: track artists, else album artists (ids preferred). */
export function artistsOf(item: BaseItem): NameId[] {
  if (item.artistItems.length > 0) return item.artistItems;
  if (item.albumArtists.length > 0) return item.albumArtists;
  return item.artists.map((name) => ({ id: '', name }));
}

/** Builds the profile from played tracks (duplicates by id are merged). */
export function buildTaste(history: BaseItem[], now: number): Taste {
  const seen = new Map<string, BaseItem>();
  for (const t of history) if (t.id !== '' && !seen.has(t.id)) seen.set(t.id, t);
  const taste: Taste = {
    genres: new Map(),
    tags: new Map(),
    artists: new Map(),
    albumPlays: new Map(),
    trackPlays: new Map(),
    size: seen.size,
  };
  for (const t of seen.values()) {
    const w = playWeight(t, now);
    for (const g of t.genres) add(taste.genres, g.name, g.id, w);
    for (const tag of t.tags) add(taste.tags, tag, '', w);
    for (const a of artistsOf(t)) add(taste.artists, a.name, a.id, w);
    taste.trackPlays.set(t.id, t.playCount);
    if (t.albumId) taste.albumPlays.set(t.albumId, (taste.albumPlays.get(t.albumId) ?? 0) + Math.max(1, t.playCount));
  }
  normalise(taste.genres);
  normalise(taste.tags);
  normalise(taste.artists);
  return taste;
}

/** Strongest features first. */
export function top(map: Map<string, Feature>, n: number, withId = false): Feature[] {
  return [...map.values()]
    .filter((f) => !withId || f.id !== '')
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
    .slice(0, n);
}

/**
 * How well `item` matches the taste, 0 when it shares nothing. `similar` maps artist
 * keys (lower-cased names) to a bonus for artists related to ones the user plays.
 * Things the user already plays a lot are pushed down so the list stays fresh.
 */
export function scoreItem(taste: Taste, item: BaseItem, similar: Map<string, number> = new Map()): Scored {
  let genre = 0;
  let bestGenre: Feature | null = null;
  for (const g of item.genres) {
    const f = taste.genres.get(keyOf(g.name));
    if (!f) continue;
    genre += f.weight;
    if (!bestGenre || f.weight > bestGenre.weight) bestGenre = f;
  }
  // Average-ish over the item's genres so a long genre list can't win by itself.
  genre /= Math.sqrt(Math.max(1, item.genres.length));

  let tag = 0;
  let bestTag: Feature | null = null;
  for (const t of item.tags) {
    const f = taste.tags.get(keyOf(t));
    if (!f) continue;
    tag += f.weight;
    if (!bestTag || f.weight > bestTag.weight) bestTag = f;
  }
  tag /= Math.sqrt(Math.max(1, item.tags.length));

  let artist = 0;
  let bestArtist = '';
  let sim = 0;
  let simArtist = '';
  for (const a of artistsOf(item)) {
    const f = taste.artists.get(keyOf(a.name));
    if (f && f.weight > artist) {
      artist = f.weight;
      bestArtist = f.label;
    }
    const s = similar.get(keyOf(a.name)) ?? 0;
    if (s > sim) {
      sim = s;
      simArtist = a.name;
    }
  }

  const parts: { kind: ReasonKind; label: string; v: number }[] = [
    { kind: 'genre', label: bestGenre?.label ?? '', v: genre },
    { kind: 'tag', label: bestTag?.label ?? '', v: 0.6 * tag },
    { kind: 'artist', label: bestArtist, v: 0.7 * artist },
    { kind: 'similar', label: simArtist, v: 0.8 * sim },
  ];
  let score = parts.reduce((s, p) => s + p.v, 0);

  const plays =
    item.type === 'MusicAlbum' ? (taste.albumPlays.get(item.id) ?? 0) : (taste.trackPlays.get(item.id) ?? item.playCount);
  score /= 1 + Math.log2(1 + plays);

  const best = parts.reduce((a, b) => (b.v > a.v ? b : a));
  return { item, score, reason: { kind: best.kind, label: best.label } };
}

/**
 * Scores, drops non-matches and duplicates, and keeps at most `maxPerArtist` items per
 * artist so one artist can't take over the list.
 */
export function rank(
  taste: Taste,
  items: BaseItem[],
  opts: { limit: number; maxPerArtist?: number; similar?: Map<string, number>; exclude?: Set<string> },
): Scored[] {
  const maxPer = opts.maxPerArtist ?? 2;
  const seen = new Set(opts.exclude ?? []);
  const scored: Scored[] = [];
  for (const item of items) {
    if (item.id === '' || seen.has(item.id)) continue;
    seen.add(item.id);
    const s = scoreItem(taste, item, opts.similar);
    if (s.score > 0) scored.push(s);
  }
  scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  const perArtist = new Map<string, number>();
  const out: Scored[] = [];
  for (const s of scored) {
    const artist = keyOf(artistsOf(s.item)[0]?.name ?? '');
    const n = perArtist.get(artist) ?? 0;
    if (artist !== '' && n >= maxPer) continue;
    perArtist.set(artist, n + 1);
    out.push(s);
    if (out.length >= opts.limit) break;
  }
  return out;
}

// ---- Pure helpers for the Discover page -------------------------------------------------

export interface ArtistSuggestion {
  artist: BaseItem;
  /** The top artist the server related it to. */
  because: string;
}

/**
 * Artists related to the user's top artists that they have not played. `lists` pairs each seed
 * artist's name with the similar artists the server returned. Order follows the seeds, one
 * artist at most once.
 */
export function suggestArtists(
  taste: Taste,
  lists: { seed: string; artists: BaseItem[] }[],
  limit: number,
): ArtistSuggestion[] {
  const seen = new Set<string>();
  const out: ArtistSuggestion[] = [];
  const queues = lists.map((l) => ({ seed: l.seed, rest: [...l.artists] }));
  // Round-robin so the first seed does not fill the whole row.
  for (let progress = true; progress && out.length < limit; ) {
    progress = false;
    for (const q of queues) {
      let a = q.rest.shift();
      while (a && (a.id === '' || seen.has(a.id) || taste.artists.has(keyOf(a.name)))) a = q.rest.shift();
      if (!a) continue;
      progress = true;
      seen.add(a.id);
      out.push({ artist: a, because: q.seed });
      if (out.length >= limit) break;
    }
  }
  return out;
}

const daysSince = (iso: string | null, now: number): number => {
  const t = iso === null ? NaN : Date.parse(iso);
  return Number.isNaN(t) ? Infinity : Math.max(0, (now - t) / DAY_MS);
};

/** Tracks the user played a lot but not for `days` days, most played first. */
export function rediscoverTracks(
  history: BaseItem[],
  now: number,
  opts: { limit: number; days?: number; minPlays?: number },
): BaseItem[] {
  const days = opts.days ?? 90;
  const minPlays = opts.minPlays ?? 3;
  const seen = new Set<string>();
  return history
    .filter((t) => {
      if (t.id === '' || t.type !== 'Audio' || seen.has(t.id)) return false;
      seen.add(t.id);
      return t.playCount >= minPlays && daysSince(t.lastPlayed, now) >= days;
    })
    .sort((a, b) => b.playCount - a.playCount || a.name.localeCompare(b.name))
    .slice(0, opts.limit);
}

/** Favourites the user has not played for `days` days (or ever). */
export function staleFavourites(items: BaseItem[], now: number, opts: { limit: number; days?: number }): BaseItem[] {
  const days = opts.days ?? 60;
  return items.filter((t) => t.id !== '' && t.isFavorite && daysSince(t.lastPlayed, now) >= days).slice(0, opts.limit);
}

/** Never-played tracks by the user's top artists, at most `perArtist` of each. */
export function deepCuts(taste: Taste, tracks: BaseItem[], opts: { limit: number; perArtist?: number }): BaseItem[] {
  const per = opts.perArtist ?? 4;
  const count = new Map<string, number>();
  const seen = new Set<string>();
  const known = tracks
    .filter((t) => t.id !== '' && t.playCount === 0 && !seen.has(t.id) && seen.add(t.id))
    .map((t) => {
      const a = artistsOf(t).map((x) => taste.artists.get(keyOf(x.name))).find(Boolean);
      return { t, w: a?.weight ?? 0, key: a?.key ?? '' };
    })
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w);
  const out: BaseItem[] = [];
  for (const x of known) {
    const n = count.get(x.key) ?? 0;
    if (n >= per) continue;
    count.set(x.key, n + 1);
    out.push(x.t);
    if (out.length >= opts.limit) break;
  }
  return out;
}

/** Recently added albums that match the taste and were never played. Keeps the incoming recency as a tie-break. */
export function newInTaste(taste: Taste, albums: BaseItem[], opts: { limit: number; exclude?: Set<string> }): Scored[] {
  const fresh = albums.filter((a) => (taste.albumPlays.get(a.id) ?? 0) === 0 && a.playCount === 0);
  return rank(taste, fresh, { limit: opts.limit, exclude: opts.exclude });
}
