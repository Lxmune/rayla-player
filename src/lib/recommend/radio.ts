// Endless radio: batches of ~20 tracks blending taste-ranked genre picks, tracks of
// similar artists and a Jellyfin instant mix. Pure selection in `pickBatch`; I/O in `buildRadio`.

import type { JellyfinClient } from '../jellyfin/client';
import type { BaseItem } from '../jellyfin/models';
import type { RadioSource } from '../player/controller.svelte';
import { radioBase } from './recommender';
import { NO_SKIPS, type SkipProfile } from './skip-profile';
import { artistsOf, rank, top } from './taste';

export const BATCH_SIZE = 20;
const key = (s: string) => s.trim().toLowerCase();
const artistKey = (t: BaseItem) => key(artistsOf(t)[0]?.name ?? '');

export interface Groups {
  /** The seed artist's own tracks (artist radio). */
  seed: BaseItem[];
  /** Taste-ranked tracks from top genres, best first. */
  genre: BaseItem[];
  /** Tracks of similar artists, best first. */
  similar: BaseItem[];
  /** Instant-mix tracks in server order. */
  mix: BaseItem[];
}

export interface PickOptions {
  size?: number;
  /** Share of the batch each group should fill; leftovers go to the other groups. */
  quotas: Record<keyof Groups, number>;
  /** Ids never to return (played in this session, recent history). */
  exclude: Set<string>;
  skips?: SkipProfile;
  maxPerArtist?: number;
  /** Lower-cased seed artist and its (larger) cap. */
  seedArtist?: string;
  seedCap?: number;
  random: () => number;
}

const ORDER: (keyof Groups)[] = ['seed', 'genre', 'similar', 'mix'];

/** Picks one batch: quotas first, then fills from whatever is left; <= N per artist; lightly shuffled. */
export function pickBatch(groups: Groups, o: PickOptions): BaseItem[] {
  const size = o.size ?? BATCH_SIZE;
  const maxPer = o.maxPerArtist ?? 2;
  const skips = o.skips ?? NO_SKIPS;
  const used = new Set(o.exclude);
  const perArtist = new Map<string, number>();
  const out: BaseItem[] = [];
  const queues = new Map<keyof Groups, BaseItem[]>(ORDER.map((g) => [g, [...groups[g]]]));

  const take = (g: keyof Groups): boolean => {
    const q = queues.get(g) ?? [];
    while (q.length > 0) {
      const t = q.shift() as BaseItem;
      if (t.id === '' || used.has(t.id) || skips.isSkipped(t.id)) continue;
      const a = artistKey(t);
      const cap = a !== '' && a === o.seedArtist ? (o.seedCap ?? maxPer) : maxPer;
      if (a !== '' && (perArtist.get(a) ?? 0) >= cap) continue;
      used.add(t.id);
      perArtist.set(a, (perArtist.get(a) ?? 0) + 1);
      out.push(t);
      return true;
    }
    return false;
  };

  for (const g of ORDER) {
    const n = Math.round(o.quotas[g] * size);
    for (let i = 0; i < n && out.length < size; i++) if (!take(g)) break;
  }
  // Fill the rest round-robin, heaviest quota first.
  const fill = [...ORDER].sort((a, b) => o.quotas[b] - o.quotas[a]);
  for (let progress = true; progress && out.length < size; ) {
    progress = false;
    for (const g of fill) if (out.length < size && take(g)) progress = true;
  }
  return lightShuffle(out, o.random);
}

/** Moves each track by a few places at most: keeps the blend, breaks the pattern. */
export function lightShuffle<T>(items: T[], random: () => number, spread = 3): T[] {
  return items
    .map((t, i) => ({ t, k: i + random() * spread }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.t);
}

function sample<T>(items: T[], n: number, random: () => number): T[] {
  return lightShuffle(items, random, items.length + 1).slice(0, n);
}

export interface RadioOptions {
  kind: 'discover' | 'artist';
  /** Artist item for `kind: 'artist'`. */
  artist?: BaseItem;
  skips?: SkipProfile;
  random?: () => number;
  now?: number;
}

export interface Radio {
  seed: BaseItem[];
  more: RadioSource;
  label: string;
}

const soft = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
const items = (client: JellyfinClient, artistId: string, limit: number) =>
  soft(client.tracks({ artistId, sortBy: 'Random', limit }).then((p) => p.items), [] as BaseItem[]);

/**
 * Creates the first batch and a source for the next ones. Returns null when there is
 * nothing to play. `exclude` grows with every batch handed out.
 */
export async function buildRadio(client: JellyfinClient, opts: RadioOptions): Promise<Radio | null> {
  const random = opts.random ?? Math.random;
  const skips = opts.skips ?? NO_SKIPS;
  const now = opts.now ?? Date.now();
  const base = await radioBase(client, now, skips);
  const { taste, history } = base;
  const exclude = new Set<string>();
  // Recently played history stays out of the radio.
  [...history]
    .sort((a, b) => Date.parse(b.lastPlayed ?? '') - Date.parse(a.lastPlayed ?? '') || 0)
    .slice(0, 40)
    .forEach((t) => exclude.add(t.id));

  const artist = opts.kind === 'artist' ? opts.artist : undefined;
  if (opts.kind === 'artist' && !artist) return null;
  let similarArtists: BaseItem[] | null = null;
  const similarOf = async (): Promise<BaseItem[]> => {
    if (similarArtists) return similarArtists;
    if (artist) {
      similarArtists = (await soft(client.similar(artist.id, 12).then((p) => p.items), [] as BaseItem[]));
    } else {
      similarArtists = base.seeds.flatMap((s) => s.similar).filter((a) => !taste.artists.has(key(a.name)));
    }
    return similarArtists ?? [];
  };

  const more: RadioSource = async (recent) => {
    recent.forEach((t) => exclude.add(t.id));
    const last = recent[recent.length - 1];
    const mixSeed = last?.id ?? artist?.id ?? sample(history, 1, random)[0]?.id;
    const simArtists = sample((await similarOf()).filter((a) => a.id !== ''), 4, random);
    const genres = sample(top(taste.genres, 5, true), 3, random);

    const [seedTracks, genreTracks, simLists, mix] = await Promise.all([
      artist ? items(client, artist.id, 30) : Promise.resolve([] as BaseItem[]),
      !artist && genres.length > 0
        ? soft(
            client.discover('Audio', { genreIds: genres.map((g) => g.id), unplayedOnly: true, limit: 150 }).then((p) => p.items),
            [] as BaseItem[],
          )
        : Promise.resolve([] as BaseItem[]),
      Promise.all(simArtists.map((a) => items(client, a.id, 15))),
      mixSeed ? soft(client.instantMix(mixSeed, 40), [] as BaseItem[]) : Promise.resolve([] as BaseItem[]),
    ]);

    const simBonus = new Map(simArtists.map((a) => [key(a.name), 1]));
    const flat = simLists.flat();
    const groups: Groups = {
      seed: sample(seedTracks, seedTracks.length, random),
      genre: rank(taste, genreTracks, { limit: 60, maxPerArtist: 4, skips, exclude }).map((s) => s.item),
      // Similar-artist tracks have no taste score of their own; random order keeps variety.
      similar: artist ? sample(flat, flat.length, random) : rank(taste, flat, { limit: 60, maxPerArtist: 4, similar: simBonus, skips, exclude }).map((s) => s.item),
      mix,
    };
    const quotas: Record<keyof Groups, number> = artist
      ? { seed: 0.25, genre: 0, similar: 0.5, mix: 0.25 }
      : { seed: 0, genre: 0.45, similar: 0.3, mix: 0.25 };
    const batch = pickBatch(groups, {
      quotas,
      exclude,
      skips,
      random,
      seedArtist: artist ? key(artist.name) : undefined,
      seedCap: 5,
    });
    batch.forEach((t) => exclude.add(t.id));
    return batch;
  };

  const seed = await more([]);
  if (seed.length === 0) return null;
  return { seed, more, label: artist ? `${artist.name} radio` : 'Discover radio' };
}
