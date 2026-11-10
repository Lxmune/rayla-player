import { describe, expect, it } from 'vitest';
import { parseBaseItem, type BaseItem } from '../../lib/jellyfin/models';
import { trackJson } from '../../lib/test-support';
import { albumPasses, applyFilters, matchPlaylists, NO_FILTERS, pendingSamples, topResult, trackPasses } from './search-filters';

const lossy = (id: string, year?: number): BaseItem =>
  parseBaseItem({
    ...trackJson(id, id),
    ProductionYear: year,
    MediaSources: [{ Id: id, Container: 'mp3', MediaStreams: [{ Type: 'Audio', Codec: 'mp3', SampleRate: 44100, BitDepth: null }] }],
  });
const hires = (id: string, year?: number): BaseItem => parseBaseItem({ ...trackJson(id, id), ProductionYear: year });
const album = (id: string, year?: number): BaseItem => parseBaseItem({ Id: id, Name: id, Type: 'MusicAlbum', ProductionYear: year });

describe('search filters', () => {
  it('filters tracks by lossless / hi-res / decade', () => {
    expect(trackPasses(lossy('a'), { ...NO_FILTERS, losslessOnly: true })).toBe(false);
    expect(trackPasses(hires('b'), { ...NO_FILTERS, hiResOnly: true })).toBe(true);
    expect(trackPasses(lossy('c', 1994), { ...NO_FILTERS, decade: 1990 })).toBe(true);
    expect(trackPasses(lossy('d', 2004), { ...NO_FILTERS, decade: 1990 })).toBe(false);
  });

  it('judges albums by a sample track and keeps unknown ones pending', () => {
    const f = { ...NO_FILTERS, hiResOnly: true };
    const a = album('x');
    expect(albumPasses(a, f, new Map())).toBe(true);
    expect(pendingSamples([a], f, new Map())).toEqual(['x']);
    expect(albumPasses(a, f, new Map([['x', lossy('t')]]))).toBe(false);
    expect(albumPasses(a, f, new Map([['x', hires('t')]]))).toBe(true);
    expect(pendingSamples([a], NO_FILTERS, new Map())).toEqual([]);
  });

  it('hides artists and playlists while narrowing', () => {
    const r = { artists: [album('ar')], albums: [], tracks: [hires('t')] };
    expect(applyFilters(r, [album('p')], NO_FILTERS, new Map()).artists).toHaveLength(1);
    const out = applyFilters(r, [album('p')], { ...NO_FILTERS, decade: 2000 }, new Map());
    expect(out.artists).toHaveLength(0);
    expect(out.playlists).toHaveLength(0);
  });

  it('matches playlists by name and picks the top result', () => {
    expect(matchPlaylists([album('Road Trip'), album('Gym')], 'road').map((p) => p.name)).toEqual(['Road Trip']);
    expect(matchPlaylists([album('Gym')], ' ')).toEqual([]);
    const r = { artists: [album('Queen Bee')], albums: [album('Queen')], tracks: [] };
    expect(topResult(r, 'queen')?.id).toBe('Queen');
  });
});
