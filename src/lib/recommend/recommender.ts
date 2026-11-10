// "For you": recommendations from the user's Jellyfin play history (play counts,
// last-played dates) and the genres / tags / artists of what they play.

import type { JellyfinClient } from '../jellyfin/client';
import type { BaseItem } from '../jellyfin/models';
import {
  buildTaste,
  deepCuts,
  newInTaste,
  rank,
  rediscoverTracks,
  staleFavourites,
  suggestArtists,
  top,
  type ArtistSuggestion,
  type Scored,
  type Taste,
} from './taste';

export interface GenreShelf {
  genre: string;
  albums: Scored[];
}

export interface ForYou {
  /** Albums the user has barely or never played that match their taste. */
  albums: Scored[];
  /** Unplayed tracks from their favourite genres, ready to play as a queue. */
  mix: BaseItem[];
  /** "Because you like …" rows for the strongest genres. */
  byGenre: GenreShelf[];
  /** Strongest genres, for labels ("Metal, J-Pop and more"). */
  topGenres: string[];
}

export const EMPTY_FOR_YOU: ForYou = { albums: [], mix: [], byGenre: [], topGenres: [] };

/** Below this many played tracks there is not enough signal; show nothing. */
export const MIN_HISTORY = 5;
const CACHE_MS = 15 * 60_000;

/** Everything the Home and Discover pages share, computed once per client. */
interface Base {
  taste: Taste;
  history: BaseItem[];
  /** Similar artists per top artist (name + id of the seed). */
  seeds: { name: string; id: string; similar: BaseItem[] }[];
  forYou: ForYou;
}

const cache = new WeakMap<JellyfinClient, { at: number; value: Base }>();
const pending = new WeakMap<JellyfinClient, Promise<Base>>();

function baseFor(client: JellyfinClient, now: number, fresh: boolean): Promise<Base> {
  const hit = cache.get(client);
  if (!fresh && hit && now - hit.at < CACHE_MS) return Promise.resolve(hit.value);
  const running = pending.get(client);
  if (!fresh && running) return running;
  const p = computeBase(client, now)
    .then((value) => {
      cache.set(client, { at: now, value });
      return value;
    })
    .finally(() => {
      if (pending.get(client) === p) pending.delete(client);
    });
  pending.set(client, p);
  return p;
}

/** Cached per client for a while; `fresh` recomputes (pull to refresh / refresh button). */
export async function forYou(client: JellyfinClient, now = Date.now(), fresh = false): Promise<ForYou> {
  return (await baseFor(client, now, fresh)).forYou;
}

async function computeBase(client: JellyfinClient, now: number): Promise<Base> {
  const [most, recent] = await Promise.all([
    client.listeningHistory({ sortBy: 'PlayCount', limit: 300 }),
    client.listeningHistory({ sortBy: 'DatePlayed', limit: 150 }),
  ]);
  const history = [...most.items, ...recent.items];
  const taste = buildTaste(history, now);
  if (taste.size < MIN_HISTORY) return { taste, history, seeds: [], forYou: EMPTY_FOR_YOU };

  const genres = top(taste.genres, 4, true);
  const artists = top(taste.artists, 4, true);
  const genreIds = genres.map((g) => g.id);

  const [genreAlbums, genreTracks, lists] = await Promise.all([
    genreIds.length > 0 ? client.discover('MusicAlbum', { genreIds, limit: 150 }).catch(() => null) : null,
    genreIds.length > 0 ? client.discover('Audio', { genreIds, unplayedOnly: true, limit: 250 }).catch(() => null) : null,
    Promise.all(artists.map((a) => client.similar(a.id, 10).catch(() => null))),
  ]);
  const seeds = artists.map((a, i) => ({ name: a.label, id: a.id, similar: lists[i]?.items ?? [] }));
  const similar = similarArtists(taste, seeds.slice(0, 3));
  const similarAlbums =
    similar.ids.length > 0 ? ((await client.albumsByArtists(similar.ids, 60).catch(() => null))?.items ?? []) : [];

  const albumPool = [...(genreAlbums?.items ?? []), ...similarAlbums];
  const albums = rank(taste, albumPool, { limit: 16, similar: similar.bonus });
  const shown = new Set(albums.map((s) => s.item.id));
  const byGenre: GenreShelf[] = [];
  for (const g of genres.slice(0, 3)) {
    const inGenre = albumPool.filter((a) => a.genres.some((x) => x.name.trim().toLowerCase() === g.key));
    const ranked = rank(taste, inGenre, { limit: 12, exclude: shown });
    ranked.forEach((s) => shown.add(s.item.id));
    if (ranked.length >= 3) byGenre.push({ genre: g.label, albums: ranked });
  }
  const mix = rank(taste, genreTracks?.items ?? [], { limit: 50, similar: similar.bonus }).map((s) => s.item);

  return {
    taste,
    history,
    seeds,
    forYou: { albums, mix, byGenre, topGenres: genres.map((g) => g.label) },
  };
}

/** Artists the server considers similar to the user's top artists, weighted by the seed. */
function similarArtists(taste: Taste, seeds: Base['seeds']) {
  const bonus = new Map<string, number>();
  const ids: string[] = [];
  for (const seed of seeds) {
    const weight = taste.artists.get(seed.name.trim().toLowerCase())?.weight ?? 0.5;
    for (const a of seed.similar) {
      const key = a.name.trim().toLowerCase();
      if (a.id === '' || taste.artists.has(key)) continue; // already known: no "discovery"
      const w = 0.8 * weight;
      if (w > (bonus.get(key) ?? 0)) bonus.set(key, w);
      if (!ids.includes(a.id)) ids.push(a.id);
    }
  }
  return { bonus, ids: ids.slice(0, 12) };
}

// ---- Discover page -------------------------------------------------------------------

export interface BecauseArtist {
  artist: string;
  albums: Scored[];
}

export interface DiscoverPage {
  /** False when there is not enough listening history to recommend anything. */
  ready: boolean;
  mix: BaseItem[];
  topGenres: string[];
  albums: Scored[];
  artists: ArtistSuggestion[];
  becauseArtist: BecauseArtist[];
  byGenre: GenreShelf[];
  newInGenres: Scored[];
  /** Tracks played a lot but not for 90+ days. */
  rediscover: BaseItem[];
  /** Unplayed tracks by top artists. */
  deepCuts: BaseItem[];
  /** Favourite tracks not played lately. */
  favourites: BaseItem[];
}

export const EMPTY_DISCOVER: DiscoverPage = {
  ready: false,
  mix: [],
  topGenres: [],
  albums: [],
  artists: [],
  becauseArtist: [],
  byGenre: [],
  newInGenres: [],
  rediscover: [],
  deepCuts: [],
  favourites: [],
};

const pageCache = new WeakMap<JellyfinClient, { at: number; value: DiscoverPage }>();

/** One failed query must not take the page down: it just leaves its section empty. */
const soft = async <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

/** All Discover sections; cached per client like `forYou`, `fresh` recomputes. */
export async function discoverPage(client: JellyfinClient, now = Date.now(), fresh = false): Promise<DiscoverPage> {
  const hit = pageCache.get(client);
  if (!fresh && hit && now - hit.at < CACHE_MS) return hit.value;
  const base = await baseFor(client, now, fresh);
  const value = await buildPage(client, base, now);
  pageCache.set(client, { at: now, value });
  return value;
}

async function buildPage(client: JellyfinClient, base: Base, now: number): Promise<DiscoverPage> {
  const { taste, forYou: fy, seeds, history } = base;
  if (taste.size < MIN_HISTORY) return EMPTY_DISCOVER;

  const genres = top(taste.genres, 3, true);
  const topArtists = top(taste.artists, 3, true);
  const empty = { items: [] as BaseItem[] };

  const [becauseLists, newByGenre, cutLists, favs] = await Promise.all([
    Promise.all(
      seeds.slice(0, 2).map((s) => {
        const ids = s.similar.filter((a) => a.id !== '' && !taste.artists.has(a.name.trim().toLowerCase())).map((a) => a.id);
        return ids.length > 0 ? soft(client.albumsByArtists(ids.slice(0, 8), 40), empty) : Promise.resolve(empty);
      }),
    ),
    Promise.all(
      genres.map((g) =>
        soft(client.albums({ genreId: g.id, sortBy: 'DateCreated,SortName', descending: true, limit: 40 }), empty).then(
          // The query does not return genres; the filter says which one each album matched.
          (page) => page.items.map((a) => (a.genres.length > 0 ? a : { ...a, genres: [{ id: g.id, name: g.label }] })),
        ),
      ),
    ),
    Promise.all(
      topArtists.map((a) => soft(client.tracks({ artistId: a.id, sortBy: 'Random', limit: 60 }), empty)),
    ),
    soft(client.tracks({ favoritesOnly: true, sortBy: 'Random', limit: 150 }), empty),
  ]);

  // Overlap with "Recommended" is fine (those mix genre and similar-artist picks); not with the genre shelves.
  const shown = new Set(fy.byGenre.flatMap((g) => g.albums).map((s) => s.item.id));
  const becauseArtist: BecauseArtist[] = [];
  seeds.slice(0, 2).forEach((s, i) => {
    const ranked = rank(taste, becauseLists[i]?.items ?? [], {
      limit: 12,
      exclude: shown,
      similar: new Map(s.similar.map((a) => [a.name.trim().toLowerCase(), 1])),
    });
    if (ranked.length >= 3) {
      ranked.forEach((r) => shown.add(r.item.id));
      becauseArtist.push({ artist: s.name, albums: ranked });
    }
  });

  return {
    ready: true,
    mix: fy.mix,
    topGenres: fy.topGenres,
    albums: fy.albums,
    artists: suggestArtists(taste, seeds.map((s) => ({ seed: s.name, artists: s.similar })), 16),
    becauseArtist,
    byGenre: fy.byGenre,
    newInGenres: newInTaste(taste, newByGenre.flat(), { limit: 16, exclude: shown }),
    rediscover: rediscoverTracks(history, now, { limit: 30 }),
    deepCuts: deepCuts(taste, cutLists.flatMap((p) => p.items), { limit: 30 }),
    favourites: staleFavourites(favs.items, now, { limit: 30 }),
  };
}
