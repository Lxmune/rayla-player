import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadsStore } from '../downloads/store.svelte';
import { memoryKv } from '../platform';
import { SettingsStore } from '../settings/store.svelte';
import {
  FakeDownloadsEngine,
  FakeEngine,
  FakeHttp,
  fakeClient,
  flush,
  track,
  trackJson,
} from '../test-support';
import { PlayerController, type PlayerEvent, type RadioSource } from './controller.svelte';
import { EngineErrors } from './errors.svelte';

function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const reportsHttp = () =>
  new FakeHttp({
    'POST /Sessions/Playing': {},
    'POST /Sessions/Playing/Progress': {},
    'POST /Sessions/Playing/Stopped': {},
  });

function setup(opts: { http?: FakeHttp; signedIn?: boolean; dlEngine?: FakeDownloadsEngine } = {}) {
  const engine = new FakeEngine();
  const http = opts.http ?? reportsHttp();
  const client = fakeClient(http);
  const errors = new EngineErrors();
  const settings = new SettingsStore({ kv: memoryKv(), engine, errors });
  const dlEngine = opts.dlEngine ?? new FakeDownloadsEngine();
  const downloads = new DownloadsStore({ engine: dlEngine, client: () => client, errors });
  const player = new PlayerController({
    engine,
    client: () => (opts.signedIn === false ? null : client),
    settings,
    downloads,
    errors,
    random: seededRandom(1),
  });
  return { engine, http, client, errors, settings, downloads, dlEngine, player };
}

describe('PlayerController', () => {
  let t: ReturnType<typeof setup>;
  const album = ['a', 'b', 'c'].map((i) => track(i, { gain: -3 }));
  const ids = () => t.player.queue.map((e) => e.item.id);

  beforeEach(async () => {
    t = setup();
    await t.player.attach();
  });

  it('play album from index loads it and arms the next track', async () => {
    await t.player.playQueue(album, { startIndex: 1 });
    expect(t.engine.calls).toEqual(['load(b,true)', 'setNext(c)']);
    const req = t.engine.loaded[0];
    expect(req?.url).toBe('https://jf.test/Audio/b/stream?static=true');
    expect(req?.headers[0]?.name).toBe('Authorization');
    expect(req?.headers[0]?.value).toContain('Token="tok"');
    expect(req?.albumId).toBe('al1');
    expect(req?.fallbackGainDb).toBe(-3);
    expect(req?.localPath).toBeNull();
    expect(t.player.current?.id).toBe('b');
    expect(t.player.playback).toBe('buffering');
    expect(t.player.durationMs).toBe(180000);
  });

  it('trackStarted advances and re-arms; end of queue stops', async () => {
    await t.player.playQueue(album);
    t.engine.trackStarted('a');
    expect(t.player.index).toBe(0);

    t.engine.trackStarted('b'); // gapless advance
    await flush();
    expect(t.player.index).toBe(1);
    expect(t.engine.lastNextId).toBe('c');

    t.engine.trackStarted('c');
    await flush();
    expect(t.player.index).toBe(2);
    expect(t.engine.lastNext).toBeNull();

    t.engine.trackEnded('c');
    await flush();
    expect(t.engine.calls[t.engine.calls.length - 1]).toBe('stop');
    expect(t.player.playback).toBe('stopped');
  });

  it('queue edits keep setNext right', async () => {
    await t.player.playQueue(album);
    await t.player.playNext([track('x')]);
    expect(t.engine.lastNextId).toBe('x');
    await t.player.addToQueue([track('y')]);
    expect(ids()).toEqual(['a', 'x', 'b', 'c', 'y']);
    await t.player.removeAt(1);
    expect(t.engine.lastNextId).toBe('b');
    await t.player.reorder(2, 1); // c before b
    expect(ids()).toEqual(['a', 'c', 'b', 'y']);
    expect(t.engine.lastNextId).toBe('c');
    await t.player.removeAt(0); // current removed: next track loads
    expect(t.engine.calls).toContain('load(c,true)');
    expect(t.engine.lastNextId).toBe('b');
  });

  it('adding to the last track arms a next track', async () => {
    await t.player.playQueue([track('a')]);
    expect(t.engine.lastNext).toBeNull();
    await t.player.addToQueue([track('z')]);
    expect(t.engine.lastNextId).toBe('z');
  });

  it('removing the last entry clears the queue', async () => {
    await t.player.playQueue([track('a')]);
    await t.player.removeAt(0);
    expect(t.player.queue).toEqual([]);
    expect(t.player.index).toBe(-1);
    expect(t.player.current).toBeNull();
    expect(t.engine.calls[t.engine.calls.length - 1]).toBe('stop');
  });

  it('shuffle keeps current first and next in sync; unshuffle restores', async () => {
    await t.player.playQueue(album, { startIndex: 1 });
    await t.player.toggleShuffle();
    expect(t.player.index).toBe(0);
    expect(t.player.current?.id).toBe('b');
    expect(new Set(ids())).toEqual(new Set(['a', 'b', 'c']));
    expect(t.engine.lastNextId).toBe(ids()[1]);
    await t.player.toggleShuffle();
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(t.player.index).toBe(1);
    expect(t.engine.lastNextId).toBe('c');
  });

  it('playQueue with shuffle starts at the chosen track', async () => {
    await t.player.playQueue(album, { startIndex: 2, shuffle: true });
    expect(t.player.shuffle).toBe(true);
    expect(t.player.index).toBe(0);
    expect(t.player.current?.id).toBe('c');
    expect(ids()).toHaveLength(3);
  });

  it('repeat all wraps, repeat one repeats', async () => {
    await t.player.playQueue(album, { startIndex: 2 });
    expect(t.engine.lastNext).toBeNull();
    await t.player.setRepeat('all');
    expect(t.engine.lastNextId).toBe('a');
    await t.player.setRepeat('one');
    expect(t.engine.lastNextId).toBe('c');

    const loadEntry = t.engine.loaded[0]?.entryId;
    const repeatEntry = t.engine.lastNext?.entryId;
    expect(repeatEntry).not.toBe(loadEntry); // told apart by entry id
    t.engine.trackStarted('c', loadEntry); // load confirmation
    await flush();
    expect(t.engine.lastNext?.entryId).toBe(repeatEntry); // no re-arm
    t.engine.trackStarted('c', repeatEntry); // repeat
    await flush();
    expect(t.player.index).toBe(2);
    expect(t.engine.lastNextId).toBe('c');
    expect(t.engine.lastNext?.entryId).not.toBe(repeatEntry);
    await t.player.setRepeat('off');
    expect(t.engine.lastNext).toBeNull();
  });

  it('cycleRepeat goes off -> all -> one -> off', async () => {
    await t.player.cycleRepeat();
    expect(t.player.repeat).toBe('all');
    await t.player.cycleRepeat();
    expect(t.player.repeat).toBe('one');
    await t.player.cycleRepeat();
    expect(t.player.repeat).toBe('off');
  });

  it('duplicate track in the queue is matched by entry id', async () => {
    const x = track('x');
    await t.player.playQueue([x, track('y'), x]);
    const first = t.engine.loaded[0]?.entryId;
    expect(t.engine.lastNextId).toBe('y');
    t.engine.trackStarted('x', first);
    expect(t.player.index).toBe(0);

    t.engine.trackStarted('y'); // gapless to y
    await flush();
    expect(t.player.index).toBe(1);
    const second = t.engine.lastNext?.entryId;
    expect(t.engine.lastNextId).toBe('x');
    expect(second).not.toBe(first);

    t.engine.trackStarted('x', second); // the second x, not the first
    await flush();
    expect(t.player.index).toBe(2);

    // A late start for an unknown entry is ignored.
    t.engine.trackStarted('x', 'bogus');
    await flush();
    expect(t.player.index).toBe(2);
  });

  it('position events for another entry are ignored', async () => {
    await t.player.playQueue(album);
    t.engine.position('b', 9000, { entry: 'elsewhere' });
    expect(t.player.positionMs).toBe(0);
  });

  it('position events update position and duration', async () => {
    await t.player.playQueue(album);
    t.engine.position('a', 5000, { dur: 123000 });
    expect(t.player.positionMs).toBe(5000);
    expect(t.player.durationMs).toBe(123000);
  });

  it('engine state and signal path events are reflected', async () => {
    await t.player.playQueue(album);
    t.engine.state('playing');
    expect(t.player.isPlaying).toBe(true);
    const path = {
      codec: 'flac',
      sourceSampleRate: 44100,
      sourceBitDepth: 16,
      channels: 2,
      stages: [],
      deviceName: 'DAC',
      outputSampleRate: 44100,
      outputBitDepth: 16,
      exclusive: true,
      bitPerfect: true,
    };
    t.engine.emit({
      kind: 'signalPathChanged',
      state: 'playing',
      trackId: 'a',
      entryId: null,
      positionMs: 0,
      durationMs: 0,
      signalPath: path,
      message: null,
      throughputBps: 0, cachedBytes: 0, totalBytes: 0,
    });
    expect(t.player.signalPath).toEqual(path);
    await t.player.next();
    expect(t.player.signalPath).toBeNull(); // cleared when a new track loads
  });

  it('engine errors are surfaced', async () => {
    await t.player.playQueue(album);
    t.engine.error('decoder exploded', 'a');
    expect(t.errors.message).toBe('decoder exploded');
  });

  it('failing engine calls are reported, not thrown', async () => {
    await t.player.playQueue(album);
    Object.assign(t.engine, {
      pause: async () => {
        throw new Error('Error: device gone');
      },
    });
    await t.player.pause();
    expect(t.errors.message).toBe('device gone');
  });

  it('bitrate cap change re-arms next with a universal URL', async () => {
    await t.player.playQueue(album);
    await t.settings.setMaxBitrate(128000);
    await flush();
    expect(t.engine.lastNext?.url).toContain('/universal');
  });

  it('next/previous jump through the queue', async () => {
    await t.player.playQueue(album);
    await t.player.next();
    expect(t.player.current?.id).toBe('b');
    await t.player.previous();
    expect(t.player.current?.id).toBe('a');
    await t.player.next();
    await t.player.next();
    await t.player.next(); // past the end, repeat off
    expect(t.engine.calls[t.engine.calls.length - 1]).toBe('stop');
    expect(t.player.playback).toBe('stopped');
  });

  it('previous restarts the track after 3 s and wraps with repeat all', async () => {
    await t.player.playQueue(album, { startIndex: 1 });
    t.engine.position('b', 5000);
    await t.player.previous();
    expect(t.engine.calls[t.engine.calls.length - 1]).toBe('seek(0)');
    expect(t.player.current?.id).toBe('b');

    await t.player.playQueue(album);
    await t.player.setRepeat('all');
    await t.player.previous();
    expect(t.player.current?.id).toBe('c');
  });

  it('togglePlay / play / seek / stop drive the engine', async () => {
    await t.player.togglePlay();
    expect(t.engine.calls).toEqual([]); // nothing loaded
    await t.player.playQueue(album);
    t.engine.state('playing');
    await t.player.togglePlay();
    expect(t.engine.calls[t.engine.calls.length - 1]).toBe('pause');
    t.engine.state('paused');
    await t.player.togglePlay();
    expect(t.engine.calls[t.engine.calls.length - 1]).toBe('play');
    await t.player.seek(7000);
    expect(t.player.positionMs).toBe(7000);
    expect(t.engine.calls[t.engine.calls.length - 1]).toBe('seek(7000)');
    await t.player.stop();
    expect(t.player.playback).toBe('stopped');
    expect(t.player.positionMs).toBe(0);
    await t.player.play(); // stopped: reload the current track
    expect(t.engine.calls.filter((c) => c.startsWith('load('))).toHaveLength(2);
  });

  it('clear empties the queue but keeps shuffle and repeat', async () => {
    await t.player.playQueue(album, { shuffle: true });
    await t.player.setRepeat('all');
    await t.player.clear();
    expect(t.player.queue).toEqual([]);
    expect(t.player.shuffle).toBe(true);
    expect(t.player.repeat).toBe('all');
    expect(t.player.playback).toBe('stopped');
  });

  it('signed out: reports an error and sends nothing to the engine', async () => {
    const s = setup({ signedIn: false });
    await s.player.playQueue(album);
    expect(s.errors.message).toBe('Not signed in.');
    expect(s.engine.calls).toEqual([]);
    expect(await s.player.playInstantMix(track('seed'))).toBe(0);
  });

  it('instant mix replaces the queue with the server mix', async () => {
    const s = setup({
      http: new FakeHttp({
        'GET /Items/seed/InstantMix': {
          Items: [trackJson('m1', 'One'), trackJson('m2', 'Two')],
        },
        'POST /Sessions/Playing': {},
      }),
    });
    const n = await s.player.playInstantMix(track('seed'));
    expect(n).toBe(2);
    expect(s.player.queue.map((e) => e.item.id)).toEqual(['m1', 'm2']);
    expect(s.engine.calls).toEqual(['load(m1,true)', 'setNext(m2)']);
  });

  describe('downloads', () => {
    it('a downloaded track plays from localPath, others stream', async () => {
      const s = setup();
      await s.downloads.load();
      await s.downloads.download([track('a')]);
      const local = s.downloads.pathFor('a');
      expect(local).toBe('/dl/a.flac');
      await s.player.playQueue([track('a'), track('b')]);
      expect(s.engine.loaded[0]?.localPath).toBe(local);
      expect(s.engine.loaded[0]?.url).toContain('/Audio/a/stream');
      expect(s.engine.lastNext?.id).toBe('b');
      expect(s.engine.lastNext?.localPath).toBeNull();
    });
  });

  describe('events for integrations', () => {
    it('forwards each engine event with its entry, item and TrackMeta', async () => {
      const seen: PlayerEvent[] = [];
      const off = t.player.onEngineEvent((e) => seen.push(e));
      await t.player.playQueue(album);
      t.engine.trackStarted('a');
      t.engine.position('a', 1500, { dur: 180000 });
      t.engine.state('paused');
      t.engine.trackStarted('b');
      t.engine.position('a', 9, { entry: 'elsewhere' }); // stale: not forwarded
      off();
      t.engine.trackStarted('c');

      expect(seen.map((e) => e.kind)).toEqual([
        'trackStarted',
        'position',
        'stateChanged',
        'trackStarted',
      ]);
      const [started, pos, state, second] = seen;
      expect(started?.item?.id).toBe('a');
      expect(started?.meta?.title).toBe('Track a');
      expect(started?.entryId).toBe(`${t.player.queue[0]?.uid}`);
      expect(pos?.positionMs).toBe(1500);
      expect(pos?.durationMs).toBe(180000);
      // No entry id on the event: resolves to the current track.
      expect(state?.state).toBe('paused');
      expect(state?.item?.id).toBe('a');
      expect(second?.item?.id).toBe('b');
      expect(second?.meta?.albumId).toBe('al1');
    });

    it('a throwing listener does not disturb playback', async () => {
      t.player.onEngineEvent(() => {
        throw new Error('bad integration');
      });
      await t.player.playQueue(album);
      t.engine.trackStarted('b');
      expect(t.player.index).toBe(1);
    });
  });

  describe('Jellyfin reporting', () => {
    it('start/progress carry volume, repeat, shuffle and queue', async () => {
      await t.settings.updateDsp({ volume: 0.4 });
      await t.player.playQueue(album, { shuffle: false });
      await t.player.setRepeat('all');
      t.player.reportNow();
      await flush();
      const start = t.http.requests.find((r) => r.path === '/Sessions/Playing');
      const startBody = start?.body as Record<string, unknown>;
      expect(startBody['ItemId']).toBe('a');
      expect(startBody['VolumeLevel']).toBe(40);
      expect(startBody['IsMuted']).toBe(false);
      expect(startBody['PlayMethod']).toBe('DirectPlay');
      expect(startBody['MediaSourceId']).toBe('a');
      const progress = [...t.http.requests]
        .reverse()
        .find((r) => r.path === '/Sessions/Playing/Progress')?.body as Record<string, unknown>;
      expect(progress['RepeatMode']).toBe('RepeatAll');
      expect(progress['PlaybackOrder']).toBe('Default');
      const queue = progress['NowPlayingQueue'] as { Id: string }[];
      expect(queue.map((e) => e.Id)).toEqual(['a', 'b', 'c']);
    });

    it('reports Stopped with the last position when jumping away', async () => {
      await t.player.playQueue(album);
      t.engine.position('a', 4000);
      await t.player.jumpTo(2);
      await flush();
      const stopped = t.http.requests.find((r) => r.path === '/Sessions/Playing/Stopped');
      const body = stopped?.body as Record<string, unknown>;
      expect(body['ItemId']).toBe('a');
      expect(body['PositionTicks']).toBe(40000000);
    });

    it('bitrate cap reports Transcode only when the server will', async () => {
      // Test tracks are 2 Mbps FLAC.
      await t.settings.setMaxBitrate(320000);
      await t.player.playQueue([track('a')]);
      await flush();
      const last = () =>
        (t.http.requests.filter((r) => r.path === '/Sessions/Playing').pop()?.body ?? {}) as Record<
          string,
          unknown
        >;
      expect(last()['PlayMethod']).toBe('Transcode');
      expect(t.engine.loaded[0]?.url).toContain('/Audio/a/universal');
      expect(new URL(t.engine.loaded[0]?.url ?? '').searchParams.get('MaxStreamingBitrate')).toBe('320000');

      await t.settings.setMaxBitrate(4000000);
      await t.player.playQueue([track('b')]);
      await flush();
      expect(last()['PlayMethod']).toBe('DirectPlay');
    });

    it('periodic progress while playing, throttled to 10 s', async () => {
      let now = 1_000_000;
      const s = setup();
      const p = new PlayerController({
        engine: s.engine,
        client: () => s.client,
        settings: s.settings,
        downloads: s.downloads,
        errors: s.errors,
        now: () => now,
      });
      await p.attach();
      await p.playQueue(album);
      s.engine.state('playing');
      const progress = () => s.http.requests.filter((r) => r.path === '/Sessions/Playing/Progress').length;
      s.engine.position('a', 1000);
      now += 5000;
      s.engine.position('a', 6000);
      await flush();
      expect(progress()).toBe(0);
      now += 6000;
      s.engine.position('a', 12000);
      await flush();
      expect(progress()).toBe(1);
    });
  });

  it('removeUpcoming drops everything after the current entry', async () => {
    await t.player.playQueue(album, { startIndex: 1 });
    await t.player.removeUpcoming();
    expect(ids()).toEqual(['a', 'b']);
    expect(t.engine.lastNext).toBeNull();
    t.player.toggleShuffle(); // original order must have been trimmed too
    await t.player.toggleShuffle();
    expect(ids()).toEqual(['a', 'b']);
  });

  describe('restore', () => {
    const snap = (positionMs: number) => ({
      items: album, index: 1, positionMs, shuffle: false, repeat: 'all' as const,
    });

    it('sets the queue paused without touching the engine', () => {
      t.player.restore(snap(30000));
      expect(ids()).toEqual(['a', 'b', 'c']);
      expect(t.player.current?.id).toBe('b');
      expect(t.player.positionMs).toBe(30000);
      expect(t.player.repeat).toBe('all');
      expect(t.player.playback).toBe('stopped');
      expect(t.engine.calls).toEqual([]);
    });

    it('the first play loads the track and seeks to the saved position', async () => {
      t.player.restore(snap(30000));
      await t.player.play();
      expect(t.engine.calls).toEqual(['load(b,true)', 'setNext(c)', 'seek(30000)']);
      expect(t.player.positionMs).toBe(30000);
    });

    it('seeking before the first play only moves the start position', async () => {
      t.player.restore(snap(30000));
      await t.player.seek(5000);
      expect(t.engine.calls).toEqual([]);
      await t.player.togglePlay();
      expect(t.engine.calls).toEqual(['load(b,true)', 'setNext(c)', 'seek(5000)']);
    });

    it('position 0 plays without a seek; clear forgets the pending seek', async () => {
      t.player.restore(snap(0));
      await t.player.play();
      expect(t.engine.calls).toEqual(['load(b,true)', 'setNext(c)']);
      t.player.restore(snap(9000));
      await t.player.clear();
      t.player.restore({ ...snap(0) });
      t.engine.calls.length = 0;
      await t.player.play();
      expect(t.engine.calls.some((c) => c.startsWith('seek'))).toBe(false);
    });
  });

  describe('prefetch and adaptive quality', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((i) => track(i));

    it('prefetches the tracks after the armed next one', async () => {
      await t.player.playQueue(many, { startIndex: 0 });
      expect(t.engine.lastNextId).toBe('b');
      expect(t.engine.lastPrefetchIds).toEqual(['c', 'd']); // default 2
      await t.settings.updateStreaming({ prefetchTracks: 4 });
      await flush();
      expect(t.engine.lastPrefetchIds).toEqual(['c', 'd', 'e', 'f']);
      await t.player.jumpTo(3);
      expect(t.engine.lastPrefetchIds).toEqual(['f']);
    });

    it('keeps throughput events (state: stopped) away from listeners', async () => {
      await t.player.playQueue(many, { startIndex: 0 });
      const seen: string[] = [];
      t.player.onEngineEvent((e) => seen.push(e.kind));
      t.engine.throughput(5_000_000);
      expect(seen).toEqual([]);
      expect(t.player.throughputBps).toBe(5_000_000);
    });

    it('wraps with repeat all, is empty for repeat one, off and stop', async () => {
      await t.player.playQueue(many, { startIndex: 4 });
      expect(t.engine.lastPrefetchIds).toEqual([]);
      await t.player.setRepeat('all');
      expect(t.engine.lastPrefetchIds).toEqual(['a', 'b']);
      await t.player.setRepeat('one');
      expect(t.engine.lastPrefetchIds).toEqual([]);
      await t.player.setRepeat('off');
      await t.settings.updateStreaming({ prefetchTracks: 0 });
      expect(t.engine.lastPrefetchIds).toEqual([]);
      await t.settings.updateStreaming({ prefetchTracks: 3 });
      await t.player.jumpTo(0);
      expect(t.engine.lastPrefetchIds).toEqual(['c', 'd', 'e']);
      await t.player.stop();
      expect(t.engine.lastPrefetchIds).toEqual([]);
    });

    it('skips downloaded tracks and does not resend identical lists', async () => {
      t.downloads.pathFor = (id: string) => (id === 'd' ? '/x/d.flac' : null);
      await t.player.playQueue(many, { startIndex: 0 });
      expect(t.engine.lastPrefetchIds).toEqual(['c']);
      const n = t.engine.prefetchCalls.length;
      await t.player.removeAt(5);
      expect(t.engine.prefetchCalls.length).toBe(n);
    });

    it('lowers the cap for upcoming tracks when adaptive and slow', async () => {
      await t.settings.updateStreaming({ adaptive: true, codec: 'aac' });
      await t.player.playQueue(many, { startIndex: 0 });
      expect(t.engine.lastNext?.url).toContain('static=true');
      t.engine.throughput(0);
      expect(t.player.throughputBps).toBeNull();
      t.engine.throughput(800_000);
      await flush();
      expect(t.player.effectiveMaxBitrate).toBe(192_000);
      const url = new URL(t.engine.lastNext?.url ?? '');
      expect(url.searchParams.get('MaxStreamingBitrate')).toBe('192000');
      expect(url.searchParams.get('AudioCodec')).toBe('aac');
      expect(t.engine.lastPrefetchIds).toEqual(['c', 'd']);
      expect(new URL(t.engine.prefetchCalls.at(-1)?.[0]?.url ?? '').searchParams.get('MaxStreamingBitrate')).toBe('192000');
      // load of the current track also uses the lowered cap
      await t.player.jumpTo(2);
      expect(t.engine.loaded.at(-1)?.url).toContain('MaxStreamingBitrate=192000');
    });

    it('adaptive off ignores throughput', async () => {
      await t.player.playQueue(many, { startIndex: 0 });
      t.engine.throughput(50_000);
      expect(t.player.effectiveMaxBitrate).toBeNull();
    });
  });
});

describe('PlayerController flac codec', () => {
  it('uses flac only when the effective cap is at least CD quality', async () => {
    const t = setup();
    await t.player.attach();
    await t.settings.updateStreaming({ codec: 'flac' });
    await t.settings.setMaxBitrate(1_411_000);
    await t.player.playQueue([track('a')]);
    const url = new URL(t.engine.loaded[0]?.url ?? '');
    expect(url.searchParams.get('AudioCodec')).toBe('flac');
    expect(url.searchParams.get('MaxAudioBitDepth')).toBe('16');
    await t.settings.setMaxBitrate(192_000);
    await t.player.playQueue([track('b')]);
    expect(new URL(t.engine.loaded[1]?.url ?? '').searchParams.get('AudioCodec')).toBe('aac');
  });
});

describe('PlayerController radio', () => {
  const seed = ['s1', 's2'].map((i) => track(i));
  let t: ReturnType<typeof setup>;
  const ids = () => t.player.queue.map((e) => e.item.id);
  const batch = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => track(`${prefix}${i}`));

  beforeEach(async () => {
    t = setup();
    await t.player.attach();
  });

  it('extends when few tracks remain, passing recent items, skipping known ids', async () => {
    const calls: string[][] = [];
    const more: RadioSource = async (recent) => {
      calls.push(recent.map((r) => r.id));
      return [track('s1'), ...batch('m', 5)];
    };
    await t.player.playRadio(seed, more, 'Mix');
    await flush();
    expect(t.player.radio).toEqual({ label: 'Mix' });
    expect(calls).toEqual([['s1']]);
    expect(ids()).toEqual(['s1', 's2', 'm0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('extends again as playback approaches the end, one call at a time', async () => {
    let n = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const more: RadioSource = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await flush();
      inFlight--;
      return batch(`r${n++}-`, 4);
    };
    await t.player.playRadio(seed, more, 'Mix');
    await flush();
    await flush();
    expect(ids().length).toBe(2 + 4);
    t.engine.trackStarted('s2');
    await flush();
    t.engine.trackStarted('r0-0');
    await flush();
    await flush();
    expect(maxInFlight).toBe(1);
    expect(ids().length).toBe(2 + 4 + 4);
  });

  it('does not extend with repeat on and resumes when repeat is off', async () => {
    const more = vi.fn<RadioSource>(async () => batch('x', 5));
    await t.player.setRepeat('all');
    await t.player.playRadio(seed, more, 'Mix');
    await flush();
    expect(more).not.toHaveBeenCalled();
    await t.player.setRepeat('off');
    await flush();
    expect(more).toHaveBeenCalledTimes(1);
  });

  it('stops after two failures and reports once', async () => {
    const more = vi.fn<RadioSource>(async () => {
      throw new Error('nope');
    });
    await t.player.playRadio(seed, more, 'Mix');
    await flush();
    expect(t.player.radio).not.toBeNull();
    await t.player.setRepeat('off');
    await flush();
    expect(more).toHaveBeenCalledTimes(2);
    expect(t.player.radio).toBeNull();
    expect(t.errors.message).toBeTruthy();
    await t.player.setRepeat('off');
    await flush();
    expect(more).toHaveBeenCalledTimes(2);
  });

  it('an empty result counts as a failure', async () => {
    const more = vi.fn<RadioSource>(async () => []);
    await t.player.playRadio(seed, more, 'Mix');
    await flush();
    await t.player.setRepeat('off');
    await flush();
    expect(t.player.radio).toBeNull();
  });

  it('replacing the queue ends the radio; appending and reordering keep it', async () => {
    const more = vi.fn<RadioSource>(async () => batch('x', 8));
    await t.player.playRadio(seed, more, 'Mix');
    await flush();
    await t.player.addToQueue([track('z')]);
    await t.player.reorder(1, 2);
    expect(t.player.radio).not.toBeNull();
    t.player.stopRadio();
    expect(t.player.radio).toBeNull();
    const before = ids().length;
    for (const id of ids().slice(1, before - 1)) t.engine.trackStarted(id);
    await flush();
    expect(ids().length).toBe(before);
    await t.player.playRadio(seed, more, 'Again');
    await t.player.playQueue(batch('q', 2));
    expect(t.player.radio).toBeNull();
    await t.player.playRadio(seed, more, 'Again');
    await t.player.clear();
    expect(t.player.radio).toBeNull();
  });
});
