// Daily mixes: the user's played tracks are grouped into a few taste clusters (greedy, by
// genre, else tag, else artist) and each cluster gets a ~50 track mix that blends favourites
// with unplayed matches. Deterministic per day and profile; cached in kv for the day.

import type { JellyfinClient } from '../jellyfin/client';
import type { BaseItem } from '../jellyfin/models';
import type { KeyValueStore } from '../platform';
import { MIN_HISTORY, radioBase } from './recommender';
import { lightShuffle } from './radio';
import { NO_SKIPS, type SkipProfile } from './skip-profile';
import { artistsOf, playWeight } from './taste';

export const MIX_SIZE = 50;
export const MAX_MIXES = 5;
export const MIN_MIXES_CLUSTER = 4;
/** Share of a mix filled with favourites / unplayed tracks (the rest is familiar tracks). */
const FAV_SHARE = 0.4;
const FRESH_SHARE = 0.5;
const MAX_PER_ARTIST = 3;

export interface DailyMix {
  id: string;
  name: string;
  tracks: BaseItem[];
  /** Up to four distinct album covers (a mosaic), first = main cover. */
  covers: BaseItem[];
}

export const dailyMixesKey = (profileId: string) => `recommend.dailymixes.${profileId}`;

const keyOf = (s: string) => s.trim().toLowerCase();

/** Local calendar day, `YYYY-MM-DD`. */
export function dayKey(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Small deterministic PRNG (xmur3 hash into mulberry32). */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Clustering -------------------------------------------------------------------------

export interface ClusterFeature {
  kind: 'genre' | 'tag' | 'artist';
  key: string;
  label: string;
  id: string;
}

/** What a track is grouped by: its genres, else its tags, else its first artist. */
export function featuresOf(t: BaseItem): ClusterFeature[] {
  const f: ClusterFeature[] = [];
  for (const g of t.genres) if (keyOf(g.name) !== '') f.push({ kind: 'genre', key: keyOf(g.name), label: g.name.trim(), id: g.id });
  if (f.length > 0) return f;
  for (const tag of t.tags) if (keyOf(tag) !== '') f.push({ kind: 'tag', key: keyOf(tag), label: tag.trim(), id: '' });
  if (f.length > 0) return f;
  const a = artistsOf(t)[0];
  return a && keyOf(a.name) !== '' ? [{ kind: 'artist', key: keyOf(a.name), label: a.name.trim(), id: a.id }] : [];
}

export interface Cluster {
  seed: ClusterFeature;
  /** Co-occurring dominant feature (another genre in half the tracks), for the name. */
  second: ClusterFeature | null;
  members: BaseItem[];
  name: string;
}

const same = (a: ClusterFeature, b: ClusterFeature) => a.kind === b.kind && a.key === b.key;

/**
 * Greedy clustering: repeatedly take the heaviest remaining feature, move every track that
 * has it into a cluster. Features with fewer than `minSize` tracks are skipped.
 */
export function clusterHistory(
  history: BaseItem[],
  now: number,
  opts: { max?: number; minSize?: number } = {},
): Cluster[] {
  const max = opts.max ?? MAX_MIXES;
  const minSize = opts.minSize ?? MIN_MIXES_CLUSTER;
  const seen = new Set<string>();
  let remaining = history.filter((t) => t.type === 'Audio' && t.id !== '' && !seen.has(t.id) && seen.add(t.id));
  const weight = new Map(remaining.map((t) => [t.id, playWeight(t, now)]));
  const blocked = new Set<string>();
  const clusters: Cluster[] = [];
  const idOf = (f: ClusterFeature) => `${f.kind}:${f.key}`;

  while (clusters.length < max && remaining.length >= minSize) {
    const totals = new Map<string, { f: ClusterFeature; w: number; n: number }>();
    for (const t of remaining) {
      for (const f of featuresOf(t)) {
        const k = idOf(f);
        if (blocked.has(k)) continue;
        const e = totals.get(k) ?? { f, w: 0, n: 0 };
        e.w += weight.get(t.id) ?? 1;
        e.n++;
        if (e.f.id === '' && f.id !== '') e.f = f;
        totals.set(k, e);
      }
    }
    const best = [...totals.values()]
      .filter((e) => e.n >= minSize)
      .sort((a, b) => b.w - a.w || a.f.key.localeCompare(b.f.key))[0];
    if (!best) break;
    const members = remaining.filter((t) => featuresOf(t).some((f) => same(f, best.f)));
    remaining = remaining.filter((t) => !members.includes(t));
    blocked.add(idOf(best.f));

    // A second dominant genre shown in the name ("Rock & Metal mix").
    const co = new Map<string, { f: ClusterFeature; w: number; n: number }>();
    for (const t of members) {
      for (const f of featuresOf(t)) {
        if (same(f, best.f)) continue;
        const e = co.get(idOf(f)) ?? { f, w: 0, n: 0 };
        e.w += weight.get(t.id) ?? 1;
        e.n++;
        co.set(idOf(f), e);
      }
    }
    const second =
      [...co.values()]
        .filter((e) => e.f.kind === best.f.kind && e.n >= members.length / 2)
        .sort((a, b) => b.w - a.w || a.f.key.localeCompare(b.f.key))[0]?.f ?? null;
    clusters.push({ seed: best.f, second, members, name: '' });
  }

  const used = new Map<string, number>();
  for (const c of clusters) {
    const base = `${c.seed.label}${c.second ? ` & ${c.second.label}` : ''} mix`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    c.name = n === 1 ? base : `${base} ${n}`;
  }
  return clusters;
}

// ---- Composing a mix --------------------------------------------------------------------

export interface ComposeOptions {
  size?: number;
  random: () => number;
  skips?: SkipProfile;
  /** Ids already used by earlier mixes of the day. */
  used?: Set<string>;
  now: number;
}

/** Deterministic shuffle: sorted by id first, so the input order does not matter. */
const shuffled = (items: BaseItem[], random: () => number): BaseItem[] =>
  lightShuffle([...items].sort((a, b) => a.id.localeCompare(b.id)), random, items.length + 1);

/** Favourites + unplayed matches + familiar cluster tracks, <= 3 per artist, shuffled. */
export function composeMix(
  cluster: Cluster,
  pools: { favourites: BaseItem[]; fresh: BaseItem[] },
  o: ComposeOptions,
): BaseItem[] {
  const size = o.size ?? MIX_SIZE;
  const skips = o.skips ?? NO_SKIPS;
  const used = o.used ?? new Set<string>();
  const inCluster = (t: BaseItem) => featuresOf(t).some((f) => same(f, cluster.seed));

  const favs = new Map<string, BaseItem>();
  for (const t of cluster.members) if (t.isFavorite) favs.set(t.id, t);
  for (const t of pools.favourites) if (!favs.has(t.id) && inCluster(t)) favs.set(t.id, t);
  const fresh = pools.fresh.filter((t) => t.playCount === 0 && !favs.has(t.id));
  const familiar = [...cluster.members]
    .filter((t) => !favs.has(t.id))
    .sort((a, b) => playWeight(b, o.now) - playWeight(a, o.now) || a.id.localeCompare(b.id));

  const queues = {
    fav: shuffled([...favs.values()], o.random),
    fresh: shuffled(fresh, o.random),
    familiar: familiar.slice(0, size * 2),
  };
  const perArtist = new Map<string, number>();
  const taken = new Set<string>();
  const out: BaseItem[] = [];
  const take = (q: BaseItem[]): boolean => {
    while (q.length > 0) {
      const t = q.shift() as BaseItem;
      if (t.type !== 'Audio' || t.id === '' || used.has(t.id) || taken.has(t.id) || skips.isSkipped(t.id)) continue;
      const artists = artistsOf(t);
      if (artists.some((a) => skips.isArtistDisliked(keyOf(a.name)))) continue;
      const a = keyOf(artists[0]?.name ?? '');
      if (a !== '' && (perArtist.get(a) ?? 0) >= MAX_PER_ARTIST) continue;
      perArtist.set(a, (perArtist.get(a) ?? 0) + 1);
      taken.add(t.id);
      out.push(t);
      return true;
    }
    return false;
  };
  const quota = (q: BaseItem[], share: number) => {
    for (let i = 0; i < Math.round(share * size) && out.length < size; i++) if (!take(q)) break;
  };
  quota(queues.fav, FAV_SHARE);
  quota(queues.fresh, FRESH_SHARE);
  for (const q of [queues.familiar, queues.fresh, queues.fav]) {
    while (out.length < size && take(q));
  }
  const mixed = lightShuffle(out, o.random, 6);
  mixed.forEach((t) => used.add(t.id));
  return mixed;
}

/** Up to four tracks with distinct album art, in play order. */
export function coversOf(tracks: BaseItem[], n = 4): BaseItem[] {
  const seen = new Set<string>();
  const out: BaseItem[] = [];
  for (const t of tracks) {
    const k = t.albumId ?? t.id;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

// ---- I/O ----------------------------------------------------------------------------------

interface Stored {
  day: string;
  mixes: { id: string; name: string; ids: string[] }[];
}

export interface DailyMixDeps {
  kv: KeyValueStore;
  profileId: string;
  now?: number;
  skips?: SkipProfile;
  /** Ignore the cache and rebuild (still deterministic for the same inputs). */
  fresh?: boolean;
}

const soft = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

async function hydrate(client: JellyfinClient, stored: Stored, skips: SkipProfile): Promise<DailyMix[]> {
  const all = [...new Set(stored.mixes.flatMap((m) => m.ids))];
  const items: BaseItem[] = [];
  for (let i = 0; i < all.length; i += 100) items.push(...(await client.itemsByIds(all.slice(i, i + 100))));
  const byId = new Map(items.map((t) => [t.id, t]));
  return stored.mixes
    .map((m) => {
      const tracks = m.ids
        .map((id) => byId.get(id))
        .filter((t): t is BaseItem => !!t && !skips.isSkipped(t.id) && !artistsOf(t).some((a) => skips.isArtistDisliked(keyOf(a.name))));
      return { id: m.id, name: m.name, tracks, covers: coversOf(tracks) };
    })
    .filter((m) => m.tracks.length >= 10);
}

function readCache(kv: KeyValueStore, profileId: string): Stored | null {
  try {
    const raw = kv.get(dailyMixesKey(profileId));
    const v: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const s = v as Stored;
    return typeof s.day === 'string' && Array.isArray(s.mixes) ? s : null;
  } catch {
    return null;
  }
}

/** Today's mixes: from the kv cache when it is from today, else built from the listening history. */
export async function dailyMixes(client: JellyfinClient, deps: DailyMixDeps): Promise<DailyMix[]> {
  const now = deps.now ?? Date.now();
  const skips = deps.skips ?? NO_SKIPS;
  const day = dayKey(now);
  if (!deps.fresh) {
    const cached = readCache(deps.kv, deps.profileId);
    if (cached && cached.day === day) {
      const mixes = await soft(hydrate(client, cached, skips), [] as DailyMix[]);
      if (mixes.length > 0 || cached.mixes.length === 0) return mixes;
    }
  }

  const base = await radioBase(client, now, skips);
  if (base.taste.size < MIN_HISTORY) return [];
  const clusters = clusterHistory(base.history, now);
  if (clusters.length === 0) return [];

  const favPage = await soft(client.tracks({ favoritesOnly: true, sortBy: 'Random', limit: 300 }), { items: [] as BaseItem[], totalRecordCount: 0, startIndex: 0 });
  const fresh = await Promise.all(
    clusters.map((c): Promise<BaseItem[]> => {
      if (c.seed.kind === 'genre' && c.seed.id !== '') {
        return soft(client.discover('Audio', { genreIds: [c.seed.id], unplayedOnly: true, limit: 150 }).then((p) => p.items), []);
      }
      if (c.seed.kind === 'artist' && c.seed.id !== '') {
        return soft(client.tracks({ artistId: c.seed.id, sortBy: 'Random', limit: 100 }).then((p) => p.items), []);
      }
      return Promise.resolve([]);
    }),
  );

  const used = new Set<string>();
  const mixes: DailyMix[] = [];
  clusters.forEach((c, i) => {
    const tracks = composeMix(c, { favourites: favPage.items, fresh: fresh[i] ?? [] }, {
      random: seededRandom(`${day}|${deps.profileId}|${c.seed.kind}:${c.seed.key}`),
      skips,
      used,
      now,
    });
    if (tracks.length >= 10) mixes.push({ id: `daily-${day}-${mixes.length + 1}`, name: c.name, tracks, covers: coversOf(tracks) });
  });
  try {
    const stored: Stored = { day, mixes: mixes.map((m) => ({ id: m.id, name: m.name, ids: m.tracks.map((t) => t.id) })) };
    deps.kv.set(dailyMixesKey(deps.profileId), JSON.stringify(stored));
  } catch {
    /* storage unavailable: the mixes still show */
  }
  return mixes;
}
