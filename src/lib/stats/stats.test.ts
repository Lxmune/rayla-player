import { describe, expect, it, vi } from 'vitest';
import { parseBaseItem, type BaseItem } from '../jellyfin/models';
import { memoryKv } from '../platform';
import type { PlayerEvent } from '../player/controller.svelte';
import { entriesFromServer, streaks, summarize, toListenEntry, type ListenEntry } from './aggregate';
import { ListenLog, listensKey, MAX_LISTENS } from './listen-log.svelte';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T12:00:00Z');

function track(id: string, artist = 'A', album = 'Al', genre = 'Rock', plays = 0): BaseItem {
  return parseBaseItem({
    Id: id, Name: id, Type: 'Audio', Album: album, AlbumId: `al-${album}`, AlbumPrimaryImageTag: 'tag',
    ArtistItems: [{ Id: `ar-${artist}`, Name: artist }], GenreItems: [{ Id: `g-${genre}`, Name: genre }],
    UserData: { PlayCount: plays, LastPlayedDate: new Date(NOW - DAY).toISOString() }, RunTimeTicks: 200 * 10_000_000,
  });
}
const listen = (t: BaseItem, ms: number, at: number): ListenEntry => toListenEntry(t, ms, at);
const opts = { now: NOW, tzOffsetMin: 0 } as const;

describe('summarize', () => {
  const entries = [
    listen(track('a', 'X', 'AlX', 'Rock'), 200_000, NOW - DAY),
    listen(track('a', 'X', 'AlX', 'Rock'), 100_000, NOW - 2 * DAY),
    listen(track('b', 'Y', 'AlY', 'Pop'), 50_000, NOW - 3 * DAY),
    listen(track('old', 'Z', 'AlZ', 'Jazz'), 400_000, NOW - 100 * DAY),
  ];

  it('filters by period and ranks by time', () => {
    const s4 = summarize(entries, { ...opts, period: '4w' });
    expect(s4.totalMs).toBe(350_000);
    expect(s4.plays).toBe(3);
    expect(s4.artists.map((a) => a.name)).toEqual(['X', 'Y']);
    expect(s4.tracks[0]).toMatchObject({ id: 'a', ms: 300_000, plays: 2 });
    expect(s4.albums[0]?.name).toBe('AlX');
    expect(s4.genres.map((g) => g.name)).toEqual(['Rock', 'Pop']);
    const s6 = summarize(entries, { ...opts, period: '6m' });
    expect(s6.artists.map((a) => a.name)).toEqual(['Z', 'X', 'Y']);
    expect(summarize(entries, { ...opts, period: '4w' }).artists.length).toBe(2);
    expect(summarize(entries, { ...opts, period: 'all', limit: 1 }).artists.length).toBe(1);
  });

  it('empty log gives an empty summary', () => {
    expect(summarize([], { ...opts, period: 'all' }).plays).toBe(0);
  });

  it('busiest hour and weekday use the timezone offset', () => {
    const at = Date.parse('2026-11-09T22:30:00Z'); // Monday 22:30 UTC
    const e = [listen(track('a'), 60_000, at)];
    const utc = summarize(e, { period: 'all', now: NOW, tzOffsetMin: 0 });
    expect(utc.busiestHour).toBe(22);
    expect(utc.busiestDay).toBe(1);
    const plus3 = summarize(e, { period: 'all', now: NOW, tzOffsetMin: 180 });
    expect(plus3.busiestHour).toBe(1);
    expect(plus3.busiestDay).toBe(2);
  });

  it('splits a track between its artists', () => {
    const t = parseBaseItem({ Id: 't', Name: 't', Type: 'Audio', ArtistItems: [{ Id: '1', Name: 'P' }, { Id: '2', Name: 'Q' }] });
    const s = summarize([listen(t, 100_000, NOW - DAY)], { ...opts, period: 'all' });
    expect(s.artists.map((a) => a.ms)).toEqual([50_000, 50_000]);
    expect(s.tracks[0]?.subtitle).toBe('P, Q');
  });
});

describe('streaks', () => {
  it('counts consecutive days ending today or yesterday', () => {
    expect(streaks([10, 11, 12], 12)).toEqual({ current: 3, longest: 3 });
    expect(streaks([10, 11, 12], 13)).toEqual({ current: 3, longest: 3 });
    expect(streaks([10, 11, 12], 14)).toEqual({ current: 0, longest: 3 });
    expect(streaks([1, 2, 3, 4, 7, 8], 8)).toEqual({ current: 2, longest: 4 });
    expect(streaks([], 8)).toEqual({ current: 0, longest: 0 });
  });

  it('summary streak spans all history, not just the period', () => {
    const e = [0, 1, 2].map((d) => listen(track('a'), 60_000, NOW - d * DAY));
    expect(summarize(e, { ...opts, period: '4w' }).streak).toBe(3);
  });
});

describe('server fallback', () => {
  it('turns play counts into weighted entries', () => {
    const e = entriesFromServer([track('a', 'X', 'AlX', 'Rock', 3), track('n', 'Y', 'AlY', 'Pop', 0)]);
    expect(e.length).toBe(1);
    const s = summarize(e, { ...opts, period: 'all' });
    expect(s.plays).toBe(3);
    expect(s.totalMs).toBe(3 * 200_000);
    expect(s.busiestHour).toBeNull();
  });
});

describe('ListenLog', () => {
  const items = [track('a'), track('b'), track('c')];
  function setup() {
    const kv = memoryKv();
    let clock = NOW;
    const log = new ListenLog({ kv, profileId: () => 'p1', clock: () => clock });
    const ev = (kind: PlayerEvent['kind'], i: number, positionMs = 0, state: PlayerEvent['state'] = 'playing'): PlayerEvent => ({
      kind, state, entryId: String(i + 1), entry: { uid: i + 1, item: items[i]! }, item: items[i]!, meta: null,
      positionMs, durationMs: 200_000, signalPath: null, message: null,
    });
    const play = (i: number, fromMs: number, toMs: number) => {
      for (let p = fromMs; p <= toMs; p += 1000) log.observe(ev('position', i, p));
    };
    return { log, kv, ev, play, tick: (ms: number) => (clock += ms) };
  }

  it('counts real played time, ignoring seeks, and records on track end', () => {
    const { log, ev, play } = setup();
    log.observe(ev('trackStarted', 0));
    play(0, 0, 20_000);
    log.observe(ev('position', 0, 120_000)); // seek forward
    play(0, 121_000, 130_000);
    log.observe(ev('trackEnded', 0, 200_000));
    expect(log.all().length).toBe(1);
    expect(log.all()[0]?.ms).toBe(30_000);
    expect(log.all()[0]).toMatchObject({ id: 'a', al: 'Al', ar: [['ar-A', 'A']], g: ['Rock'] });
  });

  it('records the previous track when the next starts and skips tiny listens', () => {
    const { log, ev, play } = setup();
    log.observe(ev('trackStarted', 0));
    play(0, 0, 12_000);
    log.observe(ev('trackStarted', 1));
    play(1, 0, 3_000);
    log.observe(ev('trackStarted', 2)); // b only 3 s
    play(2, 0, 11_000);
    log.observe(ev('stateChanged', 2, 0, 'stopped'));
    expect(log.all().map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('persists per profile after flush and caps the size', () => {
    const { log, kv, ev, play } = setup();
    log.observe(ev('trackStarted', 0));
    play(0, 0, 15_000);
    log.observe(ev('trackEnded', 0));
    log.flush();
    expect(JSON.parse(kv.get(listensKey('p1')) ?? '[]').length).toBe(1);
    const again = new ListenLog({ kv, profileId: () => 'p1' });
    expect(again.size).toBe(1);

    const big = Array.from({ length: MAX_LISTENS + 5 }, (_, i) => listen(track(`t${i}`), 20_000, i + 1));
    kv.set(listensKey('p1'), JSON.stringify(big));
    const capped = new ListenLog({ kv, profileId: () => 'p1' });
    expect(capped.size).toBe(MAX_LISTENS + 5); // loaded as is; the cap applies on the next record
    capped.observe(ev('trackStarted', 1));
    for (let p = 0; p <= 12_000; p += 1000) capped.observe(ev('position', 1, p));
    capped.observe(ev('trackEnded', 1));
    expect(capped.size).toBe(MAX_LISTENS);
    expect(capped.all()[capped.size - 1]?.id).toBe('b');
  });

  it('saves on its own after a delay', () => {
    vi.useFakeTimers();
    try {
      const { log, kv, ev, play } = setup();
      log.observe(ev('trackStarted', 0));
      play(0, 0, 15_000);
      log.observe(ev('trackEnded', 0));
      expect(kv.get(listensKey('p1'))).toBeNull();
      vi.advanceTimersByTime(6_000);
      expect(kv.get(listensKey('p1'))).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
