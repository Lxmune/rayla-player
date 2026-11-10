// "For you": recommendations from the user's Jellyfin play history (play counts,
// last-played dates) and the genres / tags / artists of what they play.

import type { JellyfinClient } from '../jellyfin/client';
import type { BaseItem } from '../jellyfin/models';
import { buildTaste, rank, top, type Scored, type Taste } from './taste';

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

const cache = new WeakMap<JellyfinClient, { at: number; value: ForYou }>();

/** Cached per client for a while; `fresh` recomputes (pull to refresh / refresh button). */
export async function forYou(client: JellyfinClient, now = Date.now(), fresh = false): Promise<ForYou> {
  const hit = cache.get(client);
  if (!fresh && hit && now - hit.at < CACHE_MS) return hit.value;
  const value = await compute(client, now);
  cache.set(client, { at: now, value });
  return value;
}

async function compute(client: JellyfinClient, now: number): Promise<ForYou> {
  const [most, recent] = await Promise.all([
    client.listeningHistory({ sortBy: 'PlayCount', limit: 300 }),
    client.listeningHistory({ sortBy: 'DatePlayed', limit: 150 }),
  ]);
  const taste = buildTaste([...most.items, ...recent.items], now);
  if (taste.size < MIN_HISTORY) return EMPTY_FOR_YOU;

  const genres = top(taste.genres, 4, true);
  const artists = top(taste.artists, 3, true);
  const genreIds = genres.map((g) => g.id);

  const [genreAlbums, genreTracks, similar] = await Promise.all([
    genreIds.length > 0 ? client.discover('MusicAlbum', { genreIds, limit: 150 }) : null,
    genreIds.length > 0 ? client.discover('Audio', { genreIds, unplayedOnly: true, limit: 250 }) : null,
    similarArtists(client, taste, artists.map((a) => a.id)),
  ]);
  const similarAlbums =
    similar.ids.length > 0 ? (await client.albumsByArtists(similar.ids, 60).catch(() => null))?.items ?? [] : [];

  const albumPool = [...(genreAlbums?.items ?? []), ...similarAlbums];
  const albums = rank(taste, albumPool, { limit: 16, similar: similar.bonus });
  const shown = new Set(albums.map((s) => s.item.id));
  const byGenre: GenreShelf[] = [];
  for (const g of genres.slice(0, 2)) {
    const inGenre = albumPool.filter((a) => a.genres.some((x) => x.name.trim().toLowerCase() === g.key));
    const ranked = rank(taste, inGenre, { limit: 12, exclude: shown });
    ranked.forEach((s) => shown.add(s.item.id));
    if (ranked.length >= 3) byGenre.push({ genre: g.label, albums: ranked });
  }
  const mix = rank(taste, genreTracks?.items ?? [], { limit: 50, similar: similar.bonus }).map((s) => s.item);

  return { albums, mix, byGenre, topGenres: genres.map((g) => g.label) };
}

/** Artists the server considers similar to the user's top artists, weighted by the seed. */
async function similarArtists(client: JellyfinClient, taste: Taste, seedIds: string[]) {
  const bonus = new Map<string, number>();
  const ids: string[] = [];
  const lists = await Promise.all(seedIds.map((id) => client.similar(id, 8).catch(() => null)));
  lists.forEach((page, i) => {
    const seed = [...taste.artists.values()].find((a) => a.id === seedIds[i]);
    for (const a of page?.items ?? []) {
      const key = a.name.trim().toLowerCase();
      if (a.id === '' || taste.artists.has(key)) continue; // already known: no "discovery"
      const w = 0.8 * (seed?.weight ?? 0.5);
      if (w > (bonus.get(key) ?? 0)) bonus.set(key, w);
      if (!ids.includes(a.id)) ids.push(a.id);
    }
  });
  return { bonus, ids: ids.slice(0, 12) };
}
