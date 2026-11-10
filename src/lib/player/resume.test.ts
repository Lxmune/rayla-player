import { describe, expect, it } from 'vitest';
import { track } from '../test-support';
import { parseResume, resumeKey, serializeResume } from './resume';

describe('resume snapshot', () => {
  it('round-trips a queue', () => {
    const raw = serializeResume({
      items: [track('a'), track('b')],
      index: 1,
      positionMs: 42_500,
      shuffle: true,
      repeat: 'all',
    });
    const snap = parseResume(raw);
    expect(snap?.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(snap).toMatchObject({ index: 1, positionMs: 42_500, shuffle: true, repeat: 'all' });
  });

  it('is defensive about bad input', () => {
    expect(parseResume(null)).toBeNull();
    expect(parseResume('')).toBeNull();
    expect(parseResume('{nope')).toBeNull();
    expect(parseResume('[]')).toBeNull();
    expect(parseResume('{"items":[]}')).toBeNull();
    const ok = JSON.parse(serializeResume({ items: [track('a')], index: 0, positionMs: 0, shuffle: false, repeat: 'off' }));
    expect(parseResume(JSON.stringify({ ...ok, index: 5 }))).toBeNull();
    const odd = parseResume(JSON.stringify({ ...ok, positionMs: 'x', repeat: 'weird', shuffle: 1 }));
    expect(odd).toMatchObject({ positionMs: 0, repeat: 'off', shuffle: false });
  });

  it('keys are per profile', () => {
    expect(resumeKey('p1')).not.toBe(resumeKey('p2'));
  });
});
