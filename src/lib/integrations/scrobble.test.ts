import { beforeEach, describe, expect, it } from 'vitest';
import { memoryKv } from '../platform';
import { ScrobbleRetryQueue, ScrobbleTracker, scrobbleTrackFor } from './scrobble';
import { ScrobbleError, type ScrobbleTrack, type Scrobbler } from './scrobblers';
import { meta } from './test-helpers';

class Fake implements Scrobbler {
  log: string[] = [];
  failing = false;
  retryable = true;
  constructor(readonly id: string) {}
  async nowPlaying(t: ScrobbleTrack) {
    this.log.push(`np:${t.title}`);
  }
  async scrobble(t: ScrobbleTrack) {
    if (this.failing) throw new ScrobbleError('x', this.retryable);
    this.log.push(`sc:${t.title}`);
  }
}

const A = meta({ id: 'a', title: 'A', durationMs: 200_000 });
const B = meta({ id: 'b', title: 'B', durationMs: 200_000 });
const bare = (title: string): ScrobbleTrack => ({
  title,
  artist: 'x',
  album: null,
  albumArtist: null,
  durationMs: null,
  trackNumber: null,
});

let fake: Fake;
let queue: ScrobbleRetryQueue;
let tracker: ScrobbleTracker;

beforeEach(() => {
  fake = new Fake('lb');
  queue = new ScrobbleRetryQueue(memoryKv());
  tracker = new ScrobbleTracker({
    scrobblers: () => [fake],
    queue,
    clock: () => 1_700_000_000_000,
  });
});

/** Continuous playback in 1 s ticks from `from` to `from + seconds` inclusive. */
async function play(
  entryId: string,
  m: typeof A,
  from: number,
  seconds: number,
  o: { duration?: number; playing?: boolean } = {},
) {
  for (let s = from; s <= from + seconds; s++) {
    await tracker.observe({
      entryId,
      meta: m,
      positionMs: s * 1000,
      durationMs: (o.duration ?? 200) * 1000,
      playing: o.playing ?? true,
    });
  }
}

describe('ScrobbleTracker', () => {
  it('now playing on start, scrobble at 50%, once', async () => {
    await play('1', A, 0, 99);
    expect(fake.log).toEqual(['np:A']);
    await play('1', A, 99, 1);
    expect(fake.log).toEqual(['np:A', 'sc:A']);
    await play('1', A, 100, 50);
    expect(fake.log.filter((e) => e.startsWith('sc:'))).toHaveLength(1);
  });

  it('4 minutes counts for long tracks', async () => {
    await play('1', A, 0, 239, { duration: 1200 });
    expect(fake.log).toEqual(['np:A']);
    await play('1', A, 239, 1, { duration: 1200 });
    expect(fake.log).toEqual(['np:A', 'sc:A']);
  });

  it('tracks under 30 s never scrobble', async () => {
    await play('1', A, 0, 29, { duration: 29 });
    expect(fake.log).toEqual(['np:A']);
  });

  it('seeking forward does not count', async () => {
    await play('1', A, 0, 10);
    await play('1', A, 150, 10);
    expect(fake.log).toEqual(['np:A']);
    expect(tracker.listened).toBe(20_000);
  });

  it('paused time does not count', async () => {
    await play('1', A, 0, 60);
    await play('1', A, 60, 200, { playing: false });
    expect(fake.log).toEqual(['np:A']);
    expect(tracker.listened).toBe(60_000);
  });

  it('a position wrap on the same entry is a new play', async () => {
    await play('1', A, 0, 100);
    expect(fake.log).toEqual(['np:A', 'sc:A']);
    await play('1', A, 100, 100);
    await play('1', A, 0, 100);
    expect(fake.log).toEqual(['np:A', 'sc:A', 'np:A', 'sc:A']);
  });

  it('same track as a different entry is a new play', async () => {
    await play('1', A, 0, 100);
    await play('2', A, 0, 100);
    expect(fake.log.filter((e) => e === 'sc:A')).toHaveLength(2);
  });

  it('skipping away before the threshold does not scrobble', async () => {
    await play('1', A, 0, 40);
    await play('2', B, 0, 10);
    expect(fake.log).toEqual(['np:A', 'np:B']);
  });

  it('nothing loaded resets the entry', async () => {
    await play('1', A, 0, 10);
    await tracker.observe({ entryId: null, meta: null, positionMs: 0, durationMs: 0, playing: false });
    await play('1', A, 0, 10);
    expect(fake.log).toEqual(['np:A', 'np:A']);
  });

  it('queues a failed scrobble, persists it and flushes later', async () => {
    fake.failing = true;
    await play('1', A, 0, 100);
    expect(fake.log).toEqual(['np:A']);
    const pending = queue.load();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ service: 'lb', listenedAtMs: 1_700_000_000_000 });
    expect(pending[0]!.track.title).toBe('A');
    fake.failing = false;
    await play('2', B, 0, 1);
    expect(fake.log).toEqual(['np:A', 'np:B', 'sc:A']);
    expect(queue.load()).toEqual([]);
  });

  it('drops permanent failures', async () => {
    fake.failing = true;
    fake.retryable = false;
    await play('1', A, 0, 100);
    expect(queue.load()).toEqual([]);
  });

  it('now-playing failures are swallowed', async () => {
    fake.nowPlaying = async () => {
      throw new ScrobbleError('down', true);
    };
    await play('1', A, 0, 5);
    expect(tracker.listened).toBe(5000);
  });
});

describe('ScrobbleRetryQueue', () => {
  it('keeps order and caps its size', () => {
    for (let i = 0; i < ScrobbleRetryQueue.maxEntries + 5; i++) {
      queue.add({ service: 'lb', listenedAtMs: i, track: bare(String(i)) });
    }
    const items = queue.load();
    expect(items).toHaveLength(ScrobbleRetryQueue.maxEntries);
    expect(items[0]!.track.title).toBe('5');
  });

  it('a retryable failure blocks that service; unknown services are kept', async () => {
    queue.add({ service: 'lb', track: bare('1'), listenedAtMs: 1 });
    queue.add({ service: 'lb', track: bare('2'), listenedAtMs: 2 });
    queue.add({ service: 'other', track: bare('3'), listenedAtMs: 3 });
    fake.failing = true;
    await queue.flush([fake]);
    expect(queue.load().map((p) => p.track.title)).toEqual(['1', '2', '3']);
    fake.failing = false;
    await queue.flush([fake]);
    expect(queue.load().map((p) => p.track.title)).toEqual(['3']);
    expect(fake.log).toEqual(['sc:1', 'sc:2']);
  });

  it('tolerates corrupt storage', () => {
    const kv = memoryKv();
    kv.set(ScrobbleRetryQueue.key, '{nope');
    expect(new ScrobbleRetryQueue(kv).load()).toEqual([]);
  });
});

describe('scrobbleTrackFor', () => {
  it('joins artists, falls back to album artist, prefers live duration', () => {
    expect(scrobbleTrackFor(meta({ artists: ['A', 'B'] }), 1000).artist).toBe('A, B');
    expect(scrobbleTrackFor(meta({ artists: [], albumArtist: 'AA' })).artist).toBe('AA');
    expect(scrobbleTrackFor(meta(), 1000).durationMs).toBe(1000);
    expect(scrobbleTrackFor(meta(), 0).durationMs).toBe(329_000);
    expect(scrobbleTrackFor(meta({ durationMs: 0 })).durationMs).toBeNull();
  });
});
