import { describe, expect, it } from 'vitest';
import { JellyfinClient } from '../jellyfin/client';
import { parseBaseItem, type BaseItem } from '../jellyfin/models';
import { discoverPage, forYou, MIN_HISTORY } from './recommender';
import {
  buildTaste,
  deepCuts,
  newInTaste,
  playWeight,
  rank,
  rediscoverTracks,
  scoreItem,
  staleFavourites,
  suggestArtists,
  top,
} from './taste';

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

describe('discover helpers', () => {
  const t = buildTaste(
    [item('h', { genres: [METAL], artist: ['ar1', 'Band'], album: 'al-h', plays: 9, last: daysAgo(1) })],
    NOW,
  );
  const artist = (id: string, name: string) => parseBaseItem({ Id: id, Name: name, Type: 'MusicArtist' });

  it('suggests unknown similar artists round-robin, once each', () => {
    const out = suggestArtists(
      t,
      [
        { seed: 'Band', artists: [artist('x1', 'Band'), artist('x2', 'Two'), artist('x3', 'Three')] },
        { seed: 'Other', artists: [artist('x2', 'Two'), artist('y1', 'Four')] },
      ],
      3,
    );
    expect(out.map((s) => s.artist.id)).toEqual(['x2', 'y1', 'x3']); // "Band" is known; x2 not repeated
    expect(out[1]!.because).toBe('Other');
  });

  it('rediscover keeps high-play tracks idle for 90+ days, most played first', () => {
    const out = rediscoverTracks(
      [
        item('a', { plays: 5, last: daysAgo(200) }),
        item('b', { plays: 12, last: daysAgo(100) }),
        item('c', { plays: 20, last: daysAgo(3) }),
        item('d', { plays: 1, last: daysAgo(400) }),
        item('b', { plays: 12, last: daysAgo(100) }),
      ],
      NOW,
      { limit: 5 },
    );
    expect(out.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('stale favourites need a favourite flag and an old or missing last play', () => {
    const fav = (id: string, last: string | null, f = true) =>
      parseBaseItem({ Id: id, Name: id, Type: 'Audio', UserData: { IsFavorite: f, PlayCount: 1, LastPlayedDate: last } });
    const out = staleFavourites([fav('a', null), fav('b', daysAgo(5)), fav('c', daysAgo(90)), fav('d', null, false)], NOW, {
      limit: 10,
    });
    expect(out.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('deep cuts are unplayed tracks by top artists, capped per artist', () => {
    const mk = (id: string, name: string, plays = 0) => item(id, { artist: ['ar1', name], plays });
    const out = deepCuts(t, [mk('1', 'Band'), mk('2', 'Band'), mk('3', 'Band'), mk('4', 'Band', 3), mk('5', 'Nobody')], {
      limit: 10,
      perArtist: 2,
    });
    expect(out.map((x) => x.id)).toEqual(['1', '2']);
  });

  it('new-in-taste drops played albums and non-matches', () => {
    const out = newInTaste(
      t,
      [
        item('n1', { type: 'MusicAlbum', genres: [METAL], artist: ['a1', 'A'] }),
        item('al-h', { type: 'MusicAlbum', genres: [METAL] }),
        item('n2', { type: 'MusicAlbum', genres: [JAZZ], artist: ['a2', 'B'] }),
      ],
      { limit: 5 },
    );
    expect(out.map((s) => s.item.id)).toEqual(['n1']);
  });
});

describe('discoverPage', () => {
  const history = Array.from({ length: MIN_HISTORY + 1 }, (_, i) =>
    item(`h${i}`, { genres: [METAL], artist: ['ar1', 'Band'], album: 'al-h', plays: 5 + i, last: daysAgo(i < 3 ? i : 200) }),
  );

  function client(fail = false) {
    const fetch = async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const q = url.searchParams;
      let items: unknown[] = [];
      if (url.pathname.endsWith('/Similar')) items = [toJson(item('ar-sim', { type: 'MusicArtist', artist: ['ar-sim', 'Sim'] }))];
      else if (q.get('Filters') === 'IsPlayed') items = history.map(toJson);
      else if (q.get('AlbumArtistIds') && q.get('IncludeItemTypes') === 'MusicAlbum')
        items = ['s1', 's2', 's3'].map((id, i) => toJson(item(id, { type: 'MusicAlbum', genres: [METAL], artist: [`s${i}`, `S${i}`] })));
      else if (q.get('GenreIds') && q.get('IncludeItemTypes') === 'MusicAlbum' && q.get('SortBy')?.startsWith('DateCreated')) {
        if (fail) return new Response('boom', { status: 500 });
        items = [toJson(item('new1', { type: 'MusicAlbum', artist: ['n1', 'Newbie'] }))];
      } else if (q.get('ArtistIds')) items = [toJson(item('cut1', { artist: ['ar1', 'Band'] }))];
      return new Response(JSON.stringify({ Items: items, TotalRecordCount: items.length }), { status: 200 });
    };
    return new JellyfinClient({ baseUrl: 'https://jf.test', deviceId: 'd', token: 't', userId: 'u1', fetch });
  }

  it('builds every section from history and similar artists', async () => {
    const r = await discoverPage(client(), NOW, true);
    expect(r.ready).toBe(true);
    expect(r.artists.map((a) => a.artist.id)).toEqual(['ar-sim']);
    expect(r.becauseArtist[0]?.artist).toBe('Band');
    expect(r.newInGenres.map((s) => s.item.id)).toEqual(['new1']);
    expect(r.newInGenres[0]!.reason.label).toBe('Metal'); // genre injected from the query
    expect(r.rediscover.length).toBeGreaterThan(0);
    expect(r.deepCuts.map((x) => x.id)).toEqual(['cut1']);
  });

  it('a failing query only empties its own section', async () => {
    const r = await discoverPage(client(true), NOW, true);
    expect(r.ready).toBe(true);
    expect(r.newInGenres).toEqual([]);
    expect(r.artists.length).toBe(1);
  });

  it('is not ready without enough history', async () => {
    const fetch = async () => new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 });
    const c = new JellyfinClient({ baseUrl: 'https://jf.test', deviceId: 'd', token: 't', userId: 'u1', fetch });
    expect((await discoverPage(c, NOW, true)).ready).toBe(false);
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
