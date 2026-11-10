import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaAction, NowPlayingInfo } from '../android';
import type { BaseItem } from '../jellyfin/models';
import { track } from '../test-support';
import { MediaSession, type MediaSessionPlayer } from './media-session';

class FakePlayer implements MediaSessionPlayer {
  current: BaseItem | null = null;
  playback: MediaSessionPlayer['playback'] = 'stopped';
  positionMs = 0;
  durationMs = 0;
  index = -1;
  repeat: MediaSessionPlayer['repeat'] = 'off';
  queue: unknown[] = [];
  calls: string[] = [];
  fail = false;
  private ls = new Set<() => void>();
  onEngineEvent(l: () => void) {
    this.ls.add(l);
    return () => void this.ls.delete(l);
  }
  fire() {
    for (const l of [...this.ls]) l();
  }
  private rec(n: string) {
    this.calls.push(n);
    return this.fail ? Promise.reject(new Error('boom')) : Promise.resolve();
  }
  play = () => this.rec('play');
  pause = () => this.rec('pause');
  next = () => this.rec('next');
  previous = () => this.rec('previous');
  seek = (ms: number) => this.rec(`seek:${ms}`);
  set(i: number, n: number, pb: MediaSessionPlayer['playback'], pos = 0, dur = 200000) {
    this.queue = Array.from({ length: n });
    this.index = i;
    this.current = track(`t${i}`);
    this.playback = pb;
    this.positionMs = pos;
    this.durationMs = dur;
  }
}

function build() {
  const player = new FakePlayer();
  const infos: NowPlayingInfo[] = [];
  let cleared = 0;
  let action: ((a: MediaAction) => void) | null = null;
  let unregistered = 0;
  const errors: unknown[] = [];
  const session = new MediaSession({
    player,
    artUrl: () => 'art://x',
    bridge: {
      updateNowPlaying: async (i) => void infos.push(i),
      clearNowPlaying: async () => void cleared++,
      onMediaAction: async (cb) => {
        action = cb;
        return () => void unregistered++;
      },
    },
    onError: (e) => errors.push(e),
  });
  return {
    player, session, infos, errors,
    cleared: () => cleared,
    unregistered: () => unregistered,
    act: (a: MediaAction) => action!(a),
  };
}

const settle = () => vi.advanceTimersByTimeAsync(60);

describe('MediaSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows nothing until playback started once', async () => {
    const t = build();
    await t.session.start();
    t.player.set(0, 3, 'paused');
    t.player.fire();
    await settle();
    expect(t.infos).toHaveLength(0);
    t.player.playback = 'playing';
    t.player.fire();
    await settle();
    expect(t.infos).toHaveLength(1);
    expect(t.infos[0]).toMatchObject({ playing: true, artUrl: 'art://x', canPrevious: false, canNext: true });
  });

  it('pushes on track change, pause and seek; coalesces bursts', async () => {
    const t = build();
    await t.session.start();
    t.player.set(0, 3, 'playing', 1000);
    t.player.fire();
    await settle();
    t.player.set(1, 3, 'buffering');
    t.player.fire();
    t.player.fire();
    await settle();
    expect(t.infos).toHaveLength(2);
    expect(t.infos[1]).toMatchObject({ playing: true, canPrevious: true });
    t.player.playback = 'paused';
    t.player.fire();
    await settle();
    expect(t.infos).toHaveLength(3);
    expect(t.infos[2]!.playing).toBe(false);
    t.player.playback = 'playing';
    t.player.fire();
    await settle();
    const n = t.infos.length;
    vi.advanceTimersByTime(1000);
    t.player.positionMs = 1000;
    t.player.fire();
    await settle();
    expect(t.infos).toHaveLength(n); // normal tick
    t.player.positionMs = 90000;
    t.player.fire();
    await settle();
    expect(t.infos).toHaveLength(n + 1);
    expect(t.infos.at(-1)!.positionMs).toBe(90000);
  });

  it('re-syncs about every 15 s while playing', async () => {
    const t = build();
    await t.session.start();
    t.player.set(0, 1, 'playing');
    t.player.fire();
    await settle();
    for (let s = 1; s <= 14; s++) {
      vi.advanceTimersByTime(1000);
      t.player.positionMs = s * 1000;
      t.player.fire();
    }
    await settle();
    expect(t.infos).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    t.player.positionMs = 15000;
    t.player.fire();
    await settle();
    expect(t.infos).toHaveLength(2);
  });

  it('clears when playback ends or the queue empties, only once', async () => {
    const t = build();
    await t.session.start();
    t.player.set(0, 1, 'playing');
    t.player.fire();
    await settle();
    t.player.playback = 'stopped';
    t.player.fire();
    await settle();
    expect(t.cleared()).toBe(1);
    t.player.current = null;
    t.player.index = -1;
    t.player.fire();
    await settle();
    expect(t.cleared()).toBe(1);
  });

  it('maps actions to player calls and swallows errors', async () => {
    const t = build();
    await t.session.start();
    for (const a of [
      { type: 'play' }, { type: 'pause' }, { type: 'stop' }, { type: 'noisy' },
      { type: 'next' }, { type: 'previous' }, { type: 'seek', positionMs: 42 },
    ] as MediaAction[]) t.act(a);
    expect(t.player.calls).toEqual(['play', 'pause', 'pause', 'pause', 'next', 'previous', 'seek:42']);
    t.player.fail = true;
    t.act({ type: 'next' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors).toHaveLength(1);
  });

  it('dispose unregisters and silences everything', async () => {
    const t = build();
    await t.session.start();
    t.player.set(0, 1, 'playing');
    t.player.fire();
    t.session.dispose();
    await settle();
    expect(t.infos).toHaveLength(0);
    expect(t.unregistered()).toBe(1);
    t.player.fire();
    t.session.observe();
    t.act({ type: 'play' });
    await settle();
    expect(t.infos).toHaveLength(0);
    expect(t.player.calls).toHaveLength(0);
  });
});
