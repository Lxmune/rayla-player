import { describe, expect, it } from 'vitest';
import { parseBaseItem, type BaseItem } from '../jellyfin/models';
import { trackJson } from '../test-support';
import { memoryKv } from '../platform';
import { evaluatePlaylist, planQueries } from './evaluate';
import {
  applyPlaylist,
  describePlaylist,
  isHiRes,
  isLossless,
  matchesRule,
  sortItems,
  SUGGESTIONS,
  type SmartPlaylist,
} from './rules';
import { loadPlaylists, parsePlaylists, savePlaylists, upsertPlaylist } from './store';

const NOW = Date.parse('2026-11-10T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function t(id: string, o: Record<string, unknown> = {}): BaseItem {
  return parseBaseItem({ ...trackJson(id, id), ...o });
}
const ud = (playCount: number, last: string | null, fav = false) => ({
  UserData: { PlayCount: playCount, IsFavorite: fav, ...(last ? { LastPlayedDate: last } : {}) },
});
const mp3 = {
  MediaSources: [{ Id: 'm', Container: 'mp3', MediaStreams: [{ Type: 'Audio', Codec: 'mp3', SampleRate: 44100, BitDepth: null }] }],
};

describe('predicates', () => {
  it('hi-res and lossless', () => {
    expect(isHiRes(t('a'))).toBe(true); // 96k/24
    expect(isHiRes(t('b', mp3))).toBe(false);
    expect(isLossless(t('a'))).toBe(true);
    expect(isLossless(t('b', mp3))).toBe(false);
  });

  it('play count, last played, never played', () => {
    const played = t('p', ud(7, daysAgo(10)));
    const stale = t('s', ud(2, daysAgo(200)));
    const never = t('n');
    expect(matchesRule(played, { field: 'playCount', op: 'gte', value: 5 }, NOW)).toBe(true);
    expect(matchesRule(stale, { field: 'playCount', op: 'gte', value: 5 }, NOW)).toBe(false);
    expect(matchesRule(played, { field: 'lastPlayed', op: 'within', days: 30 }, NOW)).toBe(true);
    expect(matchesRule(stale, { field: 'lastPlayed', op: 'within', days: 30 }, NOW)).toBe(false);
    expect(matchesRule(stale, { field: 'lastPlayed', op: 'older', days: 90 }, NOW)).toBe(true);
    expect(matchesRule(never, { field: 'lastPlayed', op: 'older', days: 90 }, NOW)).toBe(true);
    expect(matchesRule(never, { field: 'neverPlayed' }, NOW)).toBe(true);
    expect(matchesRule(played, { field: 'neverPlayed' }, NOW)).toBe(false);
  });

  it('year, decade, added, duration, artist, format', () => {
    const x = t('x', { ProductionYear: 1994, DateCreated: daysAgo(3), Artists: ['Björk'], AlbumArtist: 'Björk' });
    expect(matchesRule(x, { field: 'year', min: 1990, max: 1999 }, NOW)).toBe(true);
    expect(matchesRule(x, { field: 'year', min: 1995, max: null }, NOW)).toBe(false);
    expect(matchesRule(x, { field: 'decade', value: 1990 }, NOW)).toBe(true);
    expect(matchesRule(x, { field: 'added', days: 7 }, NOW)).toBe(true);
    expect(matchesRule(x, { field: 'added', days: 1 }, NOW)).toBe(false);
    expect(matchesRule(x, { field: 'duration', op: 'lte', seconds: 200 }, NOW)).toBe(true);
    expect(matchesRule(x, { field: 'duration', op: 'gte', seconds: 200 }, NOW)).toBe(false);
    expect(matchesRule(x, { field: 'artist', value: 'björk' }, NOW)).toBe(true);
    expect(matchesRule(x, { field: 'albumArtist', value: 'other' }, NOW)).toBe(false);
    expect(matchesRule(x, { field: 'codec', value: 'FLAC' }, NOW)).toBe(true);
    expect(matchesRule(x, { field: 'codec', value: 'mp3' }, NOW)).toBe(false);
  });

  it('genre is / is not; a track without genres has none', () => {
    const g = t('g', { Genres: ['Jazz'], GenreItems: [{ Id: 'j', Name: 'Jazz' }] });
    expect(matchesRule(g, { field: 'genre', op: 'is', value: 'jazz' }, NOW)).toBe(true);
    expect(matchesRule(g, { field: 'genre', op: 'isNot', value: 'jazz' }, NOW)).toBe(false);
    expect(matchesRule(t('u'), { field: 'genre', op: 'is', value: 'jazz' }, NOW)).toBe(false);
    expect(matchesRule(t('u'), { field: 'genre', op: 'isNot', value: 'jazz' }, NOW)).toBe(true);
    expect(matchesRule(t('u'), { field: 'genre', op: 'is', value: '' }, NOW)).toBe(true);
  });
});

describe('sorting and limits', () => {
  const items = [t('b', ud(1, daysAgo(5))), t('a', ud(9, daysAgo(50))), t('c', ud(4, daysAgo(1)))];
  it('sorts', () => {
    expect(sortItems(items, 'mostPlayed').map((i) => i.id)).toEqual(['a', 'c', 'b']);
    expect(sortItems(items, 'recentlyPlayed').map((i) => i.id)).toEqual(['c', 'b', 'a']);
    expect(sortItems(items, 'title').map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(sortItems(items, 'random', () => 0).map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
  });
  it('any / all and limit', () => {
    const p = { rules: [{ field: 'playCount' as const, op: 'gte' as const, value: 4 }, { field: 'neverPlayed' as const }], sort: 'title' as const, limit: 1 };
    expect(applyPlaylist(items, { ...p, mode: 'any' }, NOW).map((i) => i.id)).toEqual(['a']);
    expect(applyPlaylist(items, { ...p, mode: 'all', limit: null }, NOW)).toEqual([]);
  });
  it('built-in suggestions describe themselves', () => {
    expect(SUGGESTIONS.length).toBe(5);
    expect(describePlaylist(SUGGESTIONS[0]!.playlist)).toContain('Favourite');
  });
});

describe('query planning and evaluation', () => {
  const ids = (n: string) => (n.toLowerCase() === 'jazz' ? 'g-jazz' : null);
  it('all mode pushes down a genre and favourites', () => {
    const [q] = planQueries(
      { mode: 'all', sort: 'mostPlayed', rules: [{ field: 'genre', op: 'is', value: 'Jazz' }, { field: 'favourite', value: true }] },
      ids,
    );
    expect(q).toMatchObject({ genreId: 'g-jazz', favoritesOnly: true, sortBy: 'PlayCount,SortName', descending: true });
  });
  it('any mode unions genre queries and an open query for other rules', () => {
    const qs = planQueries(
      { mode: 'any', sort: 'title', rules: [{ field: 'genre', op: 'is', value: 'jazz' }, { field: 'hiRes', value: true }] },
      ids,
    );
    expect(qs).toHaveLength(2);
    expect(qs[0]?.genreId).toBe('g-jazz');
    expect(qs[1]?.genreId).toBeUndefined();
    expect(planQueries({ mode: 'any', sort: 'title', rules: [{ field: 'favourite', value: true }] }, ids)[0]?.favoritesOnly).toBeUndefined();
  });
  it('pages candidates, dedupes and applies local predicates', async () => {
    const all = [t('1', ud(9, daysAgo(1))), t('2'), t('3', ud(6, daysAgo(2)))];
    const calls: { startIndex?: number; limit?: number }[] = [];
    const client = {
      genres: async () => ({ items: [], totalRecordCount: 0, startIndex: 0 }),
      tracks: async (q: { startIndex?: number; limit?: number }) => {
        calls.push(q);
        const s = q.startIndex ?? 0;
        return { items: all.slice(s, s + 2), totalRecordCount: all.length, startIndex: s };
      },
    };
    const p: SmartPlaylist = {
      id: 'x', name: 'x', mode: 'all', sort: 'mostPlayed', limit: null, createdAt: 0,
      rules: [{ field: 'playCount', op: 'gte', value: 5 }],
    };
    const out = await evaluatePlaylist(p, { client, now: NOW });
    expect(out.map((i) => i.id)).toEqual(['1', '3']);
    expect(calls).toHaveLength(2);
    const capped = await evaluatePlaylist({ ...p, rules: [] }, { client, now: NOW, cap: 2 });
    expect(capped).toHaveLength(2);
  });
});

describe('store', () => {
  it('round-trips and repairs', () => {
    const kv = memoryKv();
    const p: SmartPlaylist = { id: 'a', name: 'A', mode: 'any', rules: [{ field: 'hiRes', value: true }], sort: 'title', limit: 25, createdAt: 1 };
    savePlaylists(kv, 'prof', [p]);
    expect(loadPlaylists(kv, 'prof')).toEqual([p]);
    expect(loadPlaylists(kv, 'other')).toEqual([]);
    expect(upsertPlaylist([p], { ...p, name: 'B' })[0]?.name).toBe('B');
    expect(parsePlaylists('nope')).toEqual([]);
    const bad = parsePlaylists(JSON.stringify([{ id: 'z', name: 'Z', sort: 'bogus', limit: -1, rules: [{ field: 'nope' }, { field: 'playCount', value: 'x' }] }]));
    expect(bad[0]).toMatchObject({ sort: 'random', limit: null, mode: 'all' });
    expect(bad[0]?.rules).toEqual([{ field: 'playCount', op: 'gte', value: 5 }]);
  });
});
