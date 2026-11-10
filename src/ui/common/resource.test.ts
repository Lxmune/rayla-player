import { describe, expect, it } from 'vitest';
import { Resource, SwrCache, clearResourceCache } from './resource.svelte';

describe('SwrCache', () => {
  it('evicts least recently used', () => {
    const c = new SwrCache(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(c.has('b')).toBe(false);
    expect(c.has('a')).toBe(true);
    expect(c.size).toBe(2);
  });
});

describe('Resource with key', () => {
  it('shows cached data immediately and revalidates', async () => {
    clearResourceCache();
    const r1 = new Resource<number>();
    await r1.load(async () => 1, 'k');
    const r2 = new Resource<number>();
    let release!: (n: number) => void;
    const p = r2.load(() => new Promise<number>((res) => (release = res)), 'k');
    expect(r2.data).toBe(1);
    expect(r2.loading).toBe(false);
    release(2);
    await p;
    expect(r2.data).toBe(2);
  });
  it('keeps stale data on refresh failure and reports errors on a miss', async () => {
    clearResourceCache();
    await new Resource<number>().load(async () => 1, 'k');
    const r = new Resource<number>();
    await r.load(async () => { throw new Error('x'); }, 'k');
    expect(r.data).toBe(1);
    expect(r.error).toBeNull();
    const m = new Resource<number>();
    await m.load(async () => { throw new Error('x'); }, 'other');
    expect(m.error).not.toBeNull();
  });
  it('clear drops entries', async () => {
    await new Resource<number>().load(async () => 1, 'z');
    clearResourceCache();
    const r = new Resource<number>();
    const p = r.load(async () => 5, 'z');
    expect(r.data).toBeNull();
    await p;
  });
});
