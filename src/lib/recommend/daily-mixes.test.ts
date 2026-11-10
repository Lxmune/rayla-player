import { describe, expect, it } from 'vitest';
import type { JellyfinClient } from '../jellyfin/client';
import { parseBaseItem, type BaseItem } from '../jellyfin/models';
import { memoryKv } from '../platform';
import { buildSkipProfile } from './skip-profile';
import { clusterHistory, composeMix, coversOf, dailyMixes, dayKey, seededRandom } from './daily-mixes';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const DAY = 86_400_000;

function t(id: string, artist: string, genre: string, plays = 0, fav = false): BaseItem {
  return parseBaseItem({
    Id: id, Name: id, Type: 'Audio', AlbumId: `al-${id}`,
    ArtistItems: [{ Id: `ar-${artist}`, Name: artist }],
    GenreItems: genre ? [{ Id: `g-${genre}`, Name: genre }] : [],
    UserData: { PlayCount: plays, IsFavorite: fav, LastPlayedDate: new Date(NOW - 5 * DAY).toISOString() },
  });
}
const many = (prefix: string, n: number, artist: (i: number) => string, genre: string, plays = 3, fav = false) =>
  Array.from({ length: n }, (_, i) => t(`${prefix}${i}`, artist(i), genre, plays, fav && i % 2 === 0));

describe('clusterHistory', () => {
  const history = [
    ...many('r', 12, (i) => `Rocker${i % 4}`, 'Rock'),
    ...many('j', 8, (i) => `Jpop${i % 3}`, 'J-Pop'),
    ...many('n', 5, () => 'Solo', ''),
  ];
  it('groups by dominant genre then falls back to artist', () => {
    const c = clusterHistory(history, NOW);
    expect(c.map((x) => x.name)).toEqual(['Rock mix', 'J-Pop mix', 'Solo mix']);
    expect(c[0]?.members.length).toBe(12);
    expect(c[2]?.seed.kind).toBe('artist');
  });
  it('ignores features with too few tracks and respects max', () => {
    expect(clusterHistory([...many('r', 3, () => 'A', 'Rock')], NOW)).toEqual([]);
    expect(clusterHistory(history, NOW, { max: 1 }).length).toBe(1);
  });
  it('names a co-occurring second genre', () => {
    const h = Array.from({ length: 6 }, (_, i) =>
      parseBaseItem({ Id: `x${i}`, Name: 'x', Type: 'Audio', GenreItems: [{ Id: '1', Name: 'Rock' }, { Id: '2', Name: 'Metal' }] }));
    expect(clusterHistory(h, NOW)[0]?.name).toMatch(/^(Rock & Metal|Metal & Rock) mix$/);
  });
});

describe('composeMix', () => {
  const cluster = clusterHistory(many('r', 20, (i) => `A${i % 10}`, 'Rock', 3, true), NOW)[0]!;
  const fresh = many('f', 60, (i) => `F${i % 30}`, 'Rock', 0);
  it('blends favourites and unplayed tracks, caps artists, and is deterministic', () => {
    const a = composeMix(cluster, { favourites: [], fresh }, { random: seededRandom('s'), now: NOW, size: 30 });
    const b = composeMix(cluster, { favourites: [], fresh: [...fresh].reverse() }, { random: seededRandom('s'), now: NOW, size: 30 });
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(a.length).toBe(30);
    expect(a.filter((x) => x.isFavorite).length).toBeGreaterThanOrEqual(8);
    expect(a.filter((x) => x.playCount === 0).length).toBeGreaterThanOrEqual(12);
    const per = new Map<string, number>();
    a.forEach((x) => per.set(x.artistItems[0]!.name, (per.get(x.artistItems[0]!.name) ?? 0) + 1));
    expect(Math.max(...per.values())).toBeLessThanOrEqual(3);
    expect(new Set(a.map((x) => x.id)).size).toBe(a.length);
  });
  it('leaves out disliked tracks and artists and tracks used by earlier mixes', () => {
    const skips = buildSkipProfile([], NOW, [
      { id: 'f0', artists: [], genres: [], at: NOW },
      { id: 'ar-F1', artists: ['f1'], genres: [], at: NOW, kind: 'MusicArtist' },
    ]);
    const used = new Set(['f2']);
    const out = composeMix(cluster, { favourites: [], fresh }, { random: seededRandom('s'), now: NOW, size: 50, skips, used });
    const ids = out.map((x) => x.id);
    expect(ids).not.toContain('f0');
    expect(ids).not.toContain('f2');
    expect(out.some((x) => x.artistItems[0]?.name === 'F1')).toBe(false);
  });
  it('covers are distinct albums', () => {
    expect(coversOf([t('a', 'x', 'g'), t('a', 'x', 'g'), t('b', 'x', 'g')]).map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('dailyMixes', () => {
  const history = [...many('r', 12, (i) => `R${i % 4}`, 'Rock'), ...many('j', 10, (i) => `J${i % 3}`, 'Pop')];
  const pool = [...many('fr', 40, (i) => `X${i}`, 'Rock', 0), ...many('fj', 40, (i) => `Y${i}`, 'Pop', 0)];
  const calls = { discover: 0 };
  const client = {
    listeningHistory: async () => ({ items: history, totalRecordCount: history.length, startIndex: 0 }),
    discover: async (_t: string, o: { genreIds: string[] }) => {
      calls.discover++;
      const items = pool.filter((p) => p.genres[0]?.id === o.genreIds[0]);
      return { items, totalRecordCount: items.length, startIndex: 0 };
    },
    similar: async () => ({ items: [], totalRecordCount: 0, startIndex: 0 }),
    albumsByArtists: async () => ({ items: [], totalRecordCount: 0, startIndex: 0 }),
    tracks: async () => ({ items: [], totalRecordCount: 0, startIndex: 0 }),
    itemsByIds: async (ids: string[]) => [...history, ...pool].filter((x) => ids.includes(x.id)),
  } as unknown as JellyfinClient;

  it('builds mixes once a day, then serves them from the kv cache', async () => {
    const kv = memoryKv();
    const first = await dailyMixes(client, { kv, profileId: 'p', now: NOW });
    expect(first.length).toBe(2);
    expect(first[0]?.name).toBe('Rock mix');
    expect(first[0]?.tracks.length).toBeGreaterThanOrEqual(30);
    expect(first[0]?.covers.length).toBeGreaterThan(0);
    const calls1 = calls.discover;
    const second = await dailyMixes(client, { kv, profileId: 'p', now: NOW + 3_600_000 });
    expect(second.map((m) => m.tracks.map((x) => x.id))).toEqual(first.map((m) => m.tracks.map((x) => x.id)));
    expect(calls.discover).toBe(calls1);
    const next = await dailyMixes(client, { kv, profileId: 'p', now: NOW + 2 * DAY });
    expect(next.length).toBe(2);
    expect(calls.discover).toBeGreaterThan(calls1);
  });

  it('dayKey is the local date', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
  });
});
