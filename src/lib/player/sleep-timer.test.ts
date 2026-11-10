import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerController, type PlayerEvent } from './controller.svelte';
import { SleepTimer } from './sleep-timer.svelte';

function fake() {
  const listeners = new Set<(e: PlayerEvent) => void>();
  const player = {
    currentEntry: { uid: 1, item: {} } as PlayerController['currentEntry'],
    queue: [] as PlayerController['queue'],
    pause: vi.fn(async () => {}),
    onEngineEvent: (l: (e: PlayerEvent) => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
  const emit = (kind: PlayerEvent['kind'], uid: number | null) =>
    listeners.forEach((l) =>
      l({ kind, entry: uid === null ? null : { uid, item: {} } } as unknown as PlayerEvent),
    );
  return { player, emit, listeners };
}

describe('SleepTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts down and pauses when it elapses', () => {
    const { player } = fake();
    const t = new SleepTimer({ player });
    t.start(15);
    expect(t.mode).toBe('timer');
    expect(t.remainingMs).toBe(15 * 60_000);
    vi.advanceTimersByTime(5 * 60_000);
    expect(t.remainingMs).toBe(10 * 60_000);
    expect(player.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10 * 60_000);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(t.mode).toBe('off');
    expect(t.remainingMs).toBe(0);
  });

  it('cancel stops it', () => {
    const { player } = fake();
    const t = new SleepTimer({ player });
    t.start(1);
    t.cancel();
    vi.advanceTimersByTime(120_000);
    expect(player.pause).not.toHaveBeenCalled();
    expect(t.mode).toBe('off');
  });

  it('restarting replaces the previous timer', () => {
    const { player } = fake();
    const t = new SleepTimer({ player });
    t.start(1);
    t.start(30);
    vi.advanceTimersByTime(60_000);
    expect(player.pause).not.toHaveBeenCalled();
  });

  it('end of track pauses when that track ends', () => {
    const { player, emit, listeners } = fake();
    const t = new SleepTimer({ player });
    t.endOfTrack();
    expect(t.mode).toBe('track');
    emit('position', 1);
    emit('trackStarted', 1);
    expect(player.pause).not.toHaveBeenCalled();
    emit('trackEnded', 1);
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(t.mode).toBe('off');
    expect(listeners.size).toBe(0);
  });

  it('end of track also fires when the next entry starts (gapless)', () => {
    const { player, emit } = fake();
    const t = new SleepTimer({ player });
    t.endOfTrack();
    emit('trackStarted', 2);
    expect(player.pause).toHaveBeenCalledTimes(1);
  });

  it('end of track with nothing playing does nothing', () => {
    const { player } = fake();
    player.currentEntry = null;
    const t = new SleepTimer({ player });
    t.endOfTrack();
    expect(t.mode).toBe('off');
  });

  it('end of album pauses when the next album starts, not between tracks of the album', () => {
    const { player, listeners } = fake();
    const t = new SleepTimer({ player });
    player.currentEntry = { uid: 1, item: { albumId: 'A' } } as never;
    t.endOfAlbum();
    expect(t.mode).toBe('album');
    const ev = (kind: string, uid: number, albumId: string) =>
      listeners.forEach((l) => l({ kind, entry: { uid, item: { albumId } } } as never));
    ev('trackStarted', 2, 'A');
    expect(player.pause).not.toHaveBeenCalled();
    ev('trackStarted', 3, 'B');
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(t.mode).toBe('off');
  });

  it('end of album also pauses when the last queue track ends', () => {
    const { player, listeners } = fake();
    const t = new SleepTimer({ player });
    const e1 = { uid: 1, item: { albumId: 'A' } };
    const e2 = { uid: 2, item: { albumId: 'A' } };
    player.queue = [e1, e2] as never;
    player.currentEntry = e1 as never;
    t.endOfAlbum();
    const fire = (e: unknown) => listeners.forEach((l) => l(e as never));
    fire({ kind: 'trackEnded', entry: e1 });
    expect(player.pause).not.toHaveBeenCalled();
    fire({ kind: 'trackStarted', entry: e2 });
    fire({ kind: 'trackEnded', entry: e2 });
    expect(player.pause).toHaveBeenCalledTimes(1);
  });

  it('ramps the volume down over the last minute and restores it after pausing', async () => {
    const { player } = fake();
    const scales: number[] = [];
    const t = new SleepTimer({ player, setVolumeScale: (s) => scales.push(s), fadeEnabled: () => true });
    t.start(2);
    vi.advanceTimersByTime(60_000);
    expect(scales).toEqual([]); // 60 s left: not yet below the fade window
    vi.advanceTimersByTime(30_000);
    expect(scales.at(-1)).toBeCloseTo(0.5, 1);
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(scales.at(-1)).toBe(1);
    expect(scales.slice(0, -1).every((v, i, a) => i === 0 || v < (a[i - 1] ?? 1))).toBe(true);
  });

  it('cancel while fading restores the volume; no fade when disabled', () => {
    const { player } = fake();
    const scales: number[] = [];
    const t = new SleepTimer({ player, setVolumeScale: (s) => scales.push(s), fadeEnabled: () => true });
    t.start(1);
    vi.advanceTimersByTime(10_000);
    expect(scales.length).toBeGreaterThan(0);
    t.cancel();
    expect(scales.at(-1)).toBe(1);
    const off: number[] = [];
    const t2 = new SleepTimer({ player, setVolumeScale: (s) => off.push(s), fadeEnabled: () => false });
    t2.start(1);
    vi.advanceTimersByTime(30_000);
    t2.cancel();
    expect(off).toEqual([]);
  });
});
