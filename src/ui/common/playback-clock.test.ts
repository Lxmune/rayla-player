import { describe, expect, it } from 'vitest';
import { ClockCore } from './playback-clock.svelte';

describe('ClockCore', () => {
  it('interpolates while playing and clamps to the duration', () => {
    const c = new ClockCore();
    c.sync(1000, true, 0);
    expect(c.read(200, 10000)).toBe(1200);
    expect(c.read(99999, 10000)).toBe(10000);
  });
  it('stays put while paused', () => {
    const c = new ClockCore();
    c.sync(1000, false, 0);
    expect(c.read(500, 10000)).toBe(1000);
  });
  it('does not run backwards on small jitter but follows real seeks', () => {
    const c = new ClockCore();
    c.sync(1000, true, 0);
    expect(c.read(300, 10000)).toBe(1300);
    c.sync(1200, true, 300); // engine slightly behind
    expect(c.read(300, 10000)).toBe(1300);
    expect(c.read(400, 10000)).toBeGreaterThanOrEqual(1300);
    c.sync(100, true, 500); // real seek back
    expect(c.read(500, 10000)).toBe(100);
  });
});
