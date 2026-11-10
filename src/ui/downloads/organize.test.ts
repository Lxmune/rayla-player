import { describe, expect, it } from 'vitest';
import type { DownloadEntry } from '../../lib/downloads/store.svelte';
import { parseBaseItem } from '../../lib/jellyfin/models';
import { filterEntries, groupEntries, sortEntries, trackCount } from './organize';

function entry(id: string, name: string, o: { album?: string; artist?: string; index?: number; at?: string; bytes?: number } = {}): DownloadEntry {
  return {
    id,
    path: `/d/${id}`,
    bytes: o.bytes ?? 100,
    addedAt: o.at ?? '2026-01-01T00:00:00Z',
    item: parseBaseItem({
      Id: id,
      Name: name,
      Type: 'Audio',
      Album: o.album ?? 'Alb',
      AlbumId: o.album ?? 'Alb',
      AlbumArtist: o.artist ?? 'Art',
      Artists: [o.artist ?? 'Art'],
      IndexNumber: o.index ?? 1,
    }),
  };
}

const e1 = entry('1', 'Zeta', { album: 'B', artist: 'Mia', index: 2, at: '2026-01-03T00:00:00Z' });
const e2 = entry('2', 'Alpha', { album: 'B', artist: 'Mia', index: 1, at: '2026-01-02T00:00:00Z' });
const e3 = entry('3', 'Mid', { album: 'A', artist: 'Zed', index: 1, at: '2026-01-04T00:00:00Z' });

describe('downloads organize', () => {
  it('filters by title, artist and album words', () => {
    expect(filterEntries([e1, e2, e3], 'mia').map((e) => e.id)).toEqual(['1', '2']);
    expect(filterEntries([e1, e2, e3], 'alpha b').map((e) => e.id)).toEqual(['2']);
    expect(filterEntries([e1, e2, e3], '  ')).toHaveLength(3);
  });

  it('sorts by recent, name and artist', () => {
    expect(sortEntries([e1, e2, e3], 'recent').map((e) => e.id)).toEqual(['3', '1', '2']);
    expect(sortEntries([e1, e2, e3], 'name').map((e) => e.id)).toEqual(['2', '3', '1']);
    expect(sortEntries([e1, e2, e3], 'artist').map((e) => e.id)).toEqual(['2', '1', '3']);
  });

  it('groups by album, groups follow the sort, tracks follow album order', () => {
    const g = groupEntries([e1, e2, e3], 'recent');
    expect(g.map((x) => x.key)).toEqual(['A', 'B']);
    expect(g[1]?.entries.map((e) => e.id)).toEqual(['2', '1']);
    expect(g[1]?.bytes).toBe(200);
  });

  it('pluralises', () => {
    expect(trackCount(1)).toBe('1 track');
    expect(trackCount(2)).toBe('2 tracks');
  });
});
