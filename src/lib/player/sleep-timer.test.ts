import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerController, type PlayerEvent } from './controller.svelte';
import { SleepTimer } from './sleep-timer.svelte';

function fake() {
  const listeners = new Set<(e: PlayerEvent) => void>();
  const player = {
    currentEntry: { uid: 1, item: {} } as PlayerController['currentEntry'],
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
});
