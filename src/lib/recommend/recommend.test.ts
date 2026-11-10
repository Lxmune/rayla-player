import { describe, expect, it } from 'vitest';
import { JellyfinClient } from '../jellyfin/client';
import { parseBaseItem, type BaseItem } from '../jellyfin/models';
import { forYou, MIN_HISTORY } from './recommender';
import { buildTaste, playWeight, rank, scoreItem, top } from './taste';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

interface Opts {
  type?: string;
  genres?: [string, string][];
  tags?: string[];
  artist?: [string, string];
  album?: string;
  plays?: number;
  last?: string | null;
}

function item(id: string, o: Opts = {}): BaseItem {
  const [artistId, artistName] = o.artist ?? ['ar-x', 'Someone'];
  return parseBaseItem({
    Id: id,
    Name: `Item ${id}`,
    Type: o.type ?? 'Audio',
    AlbumId: o.album ?? null,
    ArtistItems: [{ Id: artistId, Name: artistName }],
    AlbumArtists: [{ Id: artistId, Name: artistName }],
    GenreItems: (o.genres ?? []).map(([Id, Name]) => ({ Id, Name })),
    Tags: o.tags ?? [],
    UserData: { PlayCount: o.plays ?? 0, LastPlayedDate: o.last ?? null },
  });
}

const METAL: [string, string] = ['g-metal', 'Metal'];
const JPOP: [string, string] = ['g-jpop', 'J-Pop'];
const JAZZ: [string, string] = ['g-jazz', 'Jazz'];

describe('taste', () => {
  it('recent and frequent plays weigh more, with diminishing returns', () => {
    const fresh = playWeight(item('a', { plays: 10, last: daysAgo(0) }), NOW);
    const old = playWeight(item('b', { plays: 10, last: daysAgo(365) }), NOW);
    const once = playWeight(item('c', { plays: 1, last: daysAgo(0) }), NOW);
    expect(fresh).toBeGreaterThan(old);
    expect(old).toBeGreaterThan(0);
    expect(fresh).toBeGreaterThan(once);
    expect(fresh).toBeLessThan(once * 10);
  });

  it('builds normalised genre / tag / artist weights and merges duplicates', () => {
    const history = [
      item('1', { genres: [METAL], tags: ['Vocaloid'], artist: ['ar1', 'DECO*27'], album: 'al1', plays: 20, last: daysAgo(1) }),
      item('1', { genres: [METAL], plays: 20, last: daysAgo(1) }),
      item('2', { genres: [JPOP], tags: ['vocaloid'], artist: ['ar2', 'PinocchioP'], album: 'al2', plays: 2, last: daysAgo(3) }),
    ];
    const t = buildTaste(history, NOW);
    expect(t.size).toBe(2);
    expect(top(t.genres, 1)[0]).toMatchObject({ label: 'Metal', id: 'g-metal', weight: 1 });
    expect(t.genres.get('j-pop')!.weight).toBeLessThan(1);
    expect(t.tags.get('vocaloid')!.weight).toBe(1); // case-insensitive merge
    expect(t.albumPlays.get('al1')).toBe(20);
  });

  it('scores matches, explains why, and pushes down what is already played a lot', () => {
    const t = buildTaste(
      [item('h1', { genres: [METAL], artist: ['ar1', 'Band'], album: 'al-played', plays: 30, last: daysAgo(2) })],
      NOW,
    );
    const fresh = scoreItem(t, item('al-new', { type: 'MusicAlbum', genres: [METAL] }));
    const played = scoreItem(t, item('al-played', { type: 'MusicAlbum', genres: [METAL] }));
    const unrelated = scoreItem(t, item('al-jazz', { type: 'MusicAlbum', genres: [JAZZ] }));
    expect(fresh.reason).toEqual({ kind: 'genre', label: 'Metal' });
    expect(fresh.score).toBeGreaterThan(played.score);
    expect(unrelated.score).toBe(0);
    const sim = scoreItem(t, item('al-sim', { type: 'MusicAlbum', artist: ['ar9', 'Other Band'] }), new Map([['other band', 0.8]]));
    expect(sim.reason).toEqual({ kind: 'similar', label: 'Other Band' });
  });

  it('rank drops non-matches and caps items per artist', () => {
    const t = buildTaste([item('h', { genres: [METAL], plays: 5, last: daysAgo(1) })], NOW);
    const pool = [
      ...['a', 'b', 'c', 'd'].map((id) => item(id, { type: 'MusicAlbum', genres: [METAL], artist: ['ar1', 'Same'] })),
      item('e', { type: 'MusicAlbum', genres: [METAL], artist: ['ar2', 'Else'] }),
      item('f', { type: 'MusicAlbum', genres: [JAZZ], artist: ['ar3', 'Jazz Trio'] }),
    ];
    const out = rank(t, pool, { limit: 10 });
    expect(out.map((s) => s.item.id).sort()).toEqual(['a', 'b', 'e']);
  });
});

describe('forYou', () => {
  const history = Array.from({ length: MIN_HISTORY + 1 }, (_, i) =>
    item(`h${i}`, { genres: [i % 3 === 0 ? JPOP : METAL], artist: ['ar1', 'Band'], album: 'al-h', plays: 5 + i, last: daysAgo(i) }),
  );

  function client(responses: (q: URLSearchParams, path: string) => unknown[]) {
    const queries: URLSearchParams[] = [];
    const fetch = async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      queries.push(url.searchParams);
      const items = responses(url.searchParams, url.pathname);
      return new Response(JSON.stringify({ Items: items, TotalRecordCount: items.length }), { status: 200 });
    };
    return { queries, c: new JellyfinClient({ baseUrl: 'https://jf.test', deviceId: 'd', token: 't', userId: 'u1', fetch }) };
  }

  it('recommends unplayed matching albums, a mix and genre shelves from play history', async () => {
    const { c, queries } = client((q, path) => {
      if (path.endsWith('/Similar')) return [{ Id: 'ar-sim', Name: 'Sim Artist', Type: 'MusicArtist' }];
      if (q.get('Filters') === 'IsPlayed') return history.map(toJson);
      if (q.get('AlbumArtistIds')) return [toJson(item('al-sim', { type: 'MusicAlbum', genres: [JAZZ], artist: ['ar-sim', 'Sim Artist'] }))];
      if (q.get('IncludeItemTypes') === 'MusicAlbum')
        return ['m1', 'm2', 'm3', 'm4'].map((id, i) =>
          toJson(item(id, { type: 'MusicAlbum', genres: [METAL], artist: [`a${i}`, `Artist ${i}`] })),
        );
      return ['t1', 't2'].map((id) => toJson(item(id, { genres: [METAL] })));
    });
    const r = await forYou(c, NOW, true);
    expect(r.topGenres[0]).toBe('Metal');
    expect(r.albums.map((s) => s.item.id)).toEqual(expect.arrayContaining(['m1', 'al-sim']));
    expect(r.albums.find((s) => s.item.id === 'al-sim')?.reason.kind).toBe('similar');
    expect(r.mix.map((t) => t.id).sort()).toEqual(['t1', 't2']);
    expect(queries.some((q) => q.get('GenreIds')?.split('|').includes('g-metal'))).toBe(true);
    expect(queries.some((q) => q.get('Filters') === 'IsUnplayed')).toBe(true);
    // Cached: a second call makes no requests.
    const n = queries.length;
    await forYou(c, NOW + 1000);
    expect(queries.length).toBe(n);
  });

  it('returns nothing without enough history', async () => {
    const { c } = client(() => []);
    expect(await forYou(c, NOW, true)).toEqual({ albums: [], mix: [], byGenre: [], topGenres: [] });
  });
});

function toJson(i: BaseItem): Record<string, unknown> {
  return {
    Id: i.id,
    Name: i.name,
    Type: i.type,
    AlbumId: i.albumId,
    ArtistItems: i.artistItems.map((a) => ({ Id: a.id, Name: a.name })),
    AlbumArtists: i.albumArtists.map((a) => ({ Id: a.id, Name: a.name })),
    GenreItems: i.genres.map((g) => ({ Id: g.id, Name: g.name })),
    Tags: i.tags,
    UserData: { PlayCount: i.playCount, LastPlayedDate: i.lastPlayed },
  };
}
