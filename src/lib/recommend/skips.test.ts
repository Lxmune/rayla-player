import { describe, expect, it } from 'vitest';
import { parseBaseItem, type BaseItem } from '../jellyfin/models';
import { memoryKv } from '../platform';
import type { PlayerEvent, QueueEntry } from '../player/controller.svelte';
import { buildSkipProfile, NO_SKIPS } from './skip-profile';
import { MAX_SKIPS, skipsKey, SkipTracker } from './skips.svelte';
import { pickBatch, lightShuffle, type Groups } from './radio';
import { buildTaste, deepCuts, rank, rediscoverTracks } from './taste';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const DAY = 86_400_000;

function item(id: string, artist = 'A', genre = 'Rock', plays = 0): BaseItem {
  return parseBaseItem({
    Id: id,
    Name: id,
    Type: 'Audio',
    ArtistItems: [{ Id: `ar-${artist}`, Name: artist }],
    AlbumArtists: [{ Id: `ar-${artist}`, Name: artist }],
    GenreItems: [{ Id: `g-${genre}`, Name: genre }],
    UserData: { PlayCount: plays, IsFavorite: false, LastPlayedDate: new Date(NOW - 100 * DAY).toISOString() },
    RunTimeTicks: 200 * 10_000_000,
  });
}

function setup(items: BaseItem[]) {
  const queue: QueueEntry[] = items.map((it, i) => ({ uid: i + 1, item: it }));
  const kv = memoryKv();
  let clock = NOW;
  const tracker = new SkipTracker({ kv, profileId: () => 'p1', queue: () => queue, clock: () => clock });
  const ev = (kind: PlayerEvent['kind'], i: number, positionMs = 0, state: PlayerEvent['state'] = 'playing'): PlayerEvent => ({
    kind,
    state,
    entryId: String(i + 1),
    entry: queue[i] ?? null,
    item: queue[i]?.item ?? null,
    meta: null,
    positionMs,
    durationMs: 200_000,
    signalPath: null,
    message: null,
  });
  return { tracker, kv, ev, tick: (ms: number) => (clock += ms) };
}

const count = (kv: ReturnType<typeof memoryKv>) => JSON.parse(kv.get(skipsKey('p1')) ?? '[]').length;

describe('SkipTracker', () => {
  it('counts a quick forward skip', () => {
    const { tracker, kv, ev } = setup([item('a'), item('b')]);
    tracker.observe(ev('trackStarted', 0));
    tracker.observe(ev('position', 0, 5_000));
    tracker.observe(ev('trackStarted', 1));
    expect(count(kv)).toBe(1);
  });

  it('ignores tracks that played long enough, ended, or jumped back', () => {
    const { tracker, kv, ev } = setup([item('a'), item('b'), item('c')]);
    tracker.observe(ev('trackStarted', 0));
    tracker.observe(ev('position', 0, 31_000));
    tracker.observe(ev('trackStarted', 1)); // listened 31 s
    tracker.observe(ev('position', 1, 1_000));
    tracker.observe(ev('trackEnded', 1));
    tracker.observe(ev('trackStarted', 2)); // ended naturally
    tracker.observe(ev('position', 2, 1_000));
    tracker.observe(ev('trackStarted', 0)); // jump back, not the next entry
    expect(count(kv)).toBe(0);
  });

  it('uses 40 % of the duration for short tracks and ignores stop', () => {
    const { tracker, kv, ev } = setup([item('a'), item('b'), item('c')]);
    const e0 = { ...ev('trackStarted', 0), durationMs: 20_000 };
    tracker.observe(e0);
    tracker.observe({ ...ev('position', 0, 9_000), durationMs: 20_000 }); // > 8 s
    tracker.observe(ev('trackStarted', 1));
    expect(count(kv)).toBe(0);
    tracker.observe(ev('position', 1, 3_000));
    tracker.observe(ev('stateChanged', 1, 0, 'stopped'));
    tracker.observe(ev('trackStarted', 2));
    expect(count(kv)).toBe(0);
  });

  it('caps stored skips and persists across instances', () => {
    const { tracker, kv, ev } = setup([item('a'), item('b')]);
    for (let i = 0; i < MAX_SKIPS + 10; i++) {
      tracker.observe(ev('trackStarted', 0));
      tracker.observe(ev('trackStarted', 1));
      tracker.observe(ev('stateChanged', 1, 0, 'stopped'));
    }
    expect(count(kv)).toBe(MAX_SKIPS);
    const again = new SkipTracker({ kv, profileId: () => 'p1', queue: () => [], clock: () => NOW });
    expect(again.profile(NOW).isSkipped('a')).toBe(true);
  });
});

describe('skip profile effects', () => {
  const rec = (id: string, n: number, at = NOW) =>
    Array.from({ length: n }, () => ({ id, artists: ['a'], genres: ['rock'], at }));

  it('excludes tracks skipped twice, decays old skips', () => {
    expect(buildSkipProfile(rec('x', 2), NOW).isSkipped('x')).toBe(true);
    expect(buildSkipProfile(rec('x', 1), NOW).isSkipped('x')).toBe(false);
    expect(buildSkipProfile(rec('x', 2, NOW - 60 * DAY), NOW).isSkipped('x')).toBe(false);
  });

  it('feature factor is bounded to 0.5', () => {
    const p = buildSkipProfile([...rec('x', 50)], NOW);
    expect(p.factor('artist', 'a', 0)).toBeCloseTo(0.5);
    expect(p.factor('artist', 'a', 1000)).toBeGreaterThan(0.95);
    expect(p.factor('artist', 'zzz', 3)).toBe(1);
  });

  it('lowers taste weights of heavily skipped artists and drops skipped tracks from rank/rediscover/deepCuts', () => {
    const hist = [item('h1', 'A', 'Rock', 2), item('h2', 'B', 'Jazz', 2)];
    const skips = buildSkipProfile([...rec('s1', 4), ...rec('s2', 2)], NOW);
    const plain = buildTaste(hist, NOW);
    const t = buildTaste(hist, NOW, skips);
    expect(t.artists.get('a')!.weight).toBeLessThan(plain.artists.get('a')!.weight);
    expect(t.artists.get('a')!.weight).toBeGreaterThanOrEqual(plain.artists.get('a')!.weight * 0.5);
    expect(t.artists.get('b')!.weight).toBe(plain.artists.get('b')!.weight);

    const cands = [item('s1'), item('s2'), item('ok')];
    const ids = (x: { item: BaseItem }[]) => x.map((s) => s.item.id);
    expect(ids(rank(plain, cands, { limit: 5, maxPerArtist: 5 }))).toContain('s1');
    expect(ids(rank(plain, cands, { limit: 5, maxPerArtist: 5, skips }))).toEqual(['ok']);

    const many = [item('s1', 'A', 'Rock', 5), item('ok', 'A', 'Rock', 5)];
    expect(rediscoverTracks(many, NOW, { limit: 5, skips }).map((x) => x.id)).toEqual(['ok']);
    expect(deepCuts(plain, [item('s1'), item('ok')], { limit: 5, skips }).map((x) => x.id)).toEqual(['ok']);
    expect(NO_SKIPS.isSkipped('s1')).toBe(false);
  });
});

describe('pickBatch', () => {
  const g = (prefix: string, artist: (i: number) => string, n = 10): BaseItem[] =>
    Array.from({ length: n }, (_, i) => item(`${prefix}${i}`, artist(i)));
  const noShuffle = () => 0;

  it('blends groups, caps two per artist, excludes played and skipped', () => {
    const groups: Groups = {
      seed: [],
      genre: g('g', () => 'G'),
      similar: g('s', (i) => `S${i % 3}`),
      mix: g('m', (i) => `M${i}`),
    };
    const skips = buildSkipProfile([...rec2('m0', 2)], NOW);
    const batch = pickBatch(groups, {
      size: 10,
      quotas: { seed: 0, genre: 0.5, similar: 0.3, mix: 0.2 },
      exclude: new Set(['s0']),
      skips,
      random: noShuffle,
    });
    const ids = batch.map((t) => t.id);
    expect(ids).not.toContain('s0');
    expect(ids).not.toContain('m0');
    expect(new Set(ids).size).toBe(ids.length);
    const per = new Map<string, number>();
    batch.forEach((t) => per.set(t.artistItems[0]?.name ?? '', (per.get(t.artistItems[0]?.name ?? '') ?? 0) + 1));
    expect(Math.max(...per.values())).toBeLessThanOrEqual(2);
    expect(ids.some((i) => i.startsWith('g'))).toBe(true);
    expect(ids.some((i) => i.startsWith('m'))).toBe(true);
  });

  it('keeps the seed artist a minority in artist radio', () => {
    const groups: Groups = {
      seed: g('x', () => 'Seed', 30),
      genre: [],
      similar: g('s', (i) => `S${i}`, 30),
      mix: g('m', (i) => `M${i}`, 30),
    };
    const batch = pickBatch(groups, {
      quotas: { seed: 0.25, genre: 0, similar: 0.5, mix: 0.25 },
      exclude: new Set(),
      seedArtist: 'seed',
      seedCap: 5,
      random: noShuffle,
    });
    expect(batch).toHaveLength(20);
    expect(batch.filter((t) => t.artistItems[0]?.name === 'Seed').length).toBeLessThanOrEqual(5);
  });

  it('lightShuffle keeps all items and moves them only a little', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i);
    let n = 0;
    const out = lightShuffle(arr, () => ((n += 7) % 10) / 10);
    expect([...out].sort((a, b) => a - b)).toEqual(arr);
    out.forEach((v, i) => expect(Math.abs(v - i)).toBeLessThanOrEqual(3));
  });
});

function rec2(id: string, n: number) {
  return Array.from({ length: n }, () => ({ id, artists: ['x'], genres: ['y'], at: NOW }));
}

describe('buildRadio', () => {
  it('builds a seed batch and extends without repeating', async () => {
    const { buildRadio } = await import('./radio');
    const hist = Array.from({ length: 8 }, (_, i) => item(`h${i}`, `H${i}`, 'Rock', 3));
    const pool = Array.from({ length: 60 }, (_, i) => item(`p${i}`, `P${i % 15}`, 'Rock'));
    const page = (items: BaseItem[]) => ({ items, totalRecordCount: items.length, startIndex: 0 });
    const client = {
      listeningHistory: async () => page(hist),
      discover: async () => page(pool),
      similar: async () => page([]),
      albumsByArtists: async () => page([]),
      tracks: async () => page(pool.slice(30)),
      instantMix: async () => pool.slice(40),
    } as unknown as import('../jellyfin/client').JellyfinClient;
    const radio = await buildRadio(client, { kind: 'discover', random: () => 0.5, now: NOW });
    expect(radio?.label).toBe('Discover radio');
    expect(radio!.seed.length).toBeGreaterThan(0);
    const next = await radio!.more(radio!.seed);
    const seen = new Set(radio!.seed.map((t) => t.id));
    expect(next.every((t) => !seen.has(t.id))).toBe(true);
    const artist = await buildRadio(client, { kind: 'artist', artist: item('x', 'Seed'), random: () => 0.5, now: NOW });
    expect(artist?.label).toBe('x radio');
  });
});

describe('dislikes', () => {
  it('excludes a disliked track forever and persists per profile', () => {
    const { tracker, kv } = setup([item('a')]);
    tracker.dislike(item('a', 'Art', 'Pop'));
    const p = tracker.profile(NOW + 400 * DAY);
    expect(p.isSkipped('a')).toBe(true);
    expect(p.isDisliked('a')).toBe(true);
    expect(tracker.isDisliked('a')).toBe(true);
    const again = new SkipTracker({ kv, profileId: () => 'p1', queue: () => [], clock: () => NOW });
    expect(again.profile().isSkipped('a')).toBe(true);
    again.undislike('a');
    expect(again.profile().isSkipped('a')).toBe(false);
  });

  it('drops artist and genre weights more than a skip and can go below 0.5', () => {
    const skip = buildSkipProfile([{ id: 'a', artists: ['x'], genres: ['g'], at: NOW }], NOW);
    const dis = buildSkipProfile([], NOW, [{ id: 'a', artists: ['x'], genres: ['g'], at: NOW }]);
    expect(dis.factor('artist', 'x', 2)).toBeLessThan(skip.factor('artist', 'x', 2));
    expect(dis.factor('artist', 'x', 0)).toBeGreaterThanOrEqual(0.25);
    expect(dis.factor('artist', 'x', 0)).toBeLessThan(0.5 + 1e-9);
    expect(dis.factor('genre', 'zzz', 0)).toBe(1);
  });

  it('a disliked artist drops all their tracks from rank and radio batches', () => {
    const artist = parseBaseItem({ Id: 'ar-Bad', Name: 'Bad', Type: 'MusicArtist' });
    const { tracker } = setup([]);
    tracker.dislike(artist);
    const skips = tracker.profile();
    expect(skips.isArtistDisliked('bad')).toBe(true);
    const taste = buildTaste([item('h1', 'Bad', 'Rock', 3), item('h2', 'Good', 'Rock', 3)], NOW);
    const ranked = rank(taste, [item('n1', 'Bad'), item('n2', 'Good')], { limit: 5, skips });
    expect(ranked.map((r) => r.item.id)).toEqual(['n2']);
  });

  it('dislike of a track lowers its artist in the taste', () => {
    const hist = [item('h1', 'A', 'Rock', 3), item('h2', 'B', 'Pop', 3)];
    const { tracker } = setup([]);
    tracker.dislike(item('h1', 'A', 'Rock', 3));
    const t = buildTaste(hist, NOW, tracker.profile());
    expect(t.artists.get('a')!.weight).toBeLessThan(t.artists.get('b')!.weight);
  });
});
