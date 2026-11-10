import { describe, expect, it } from 'vitest';
import { edgeScroll, shiftFor, targetIndex } from './reorder';

describe('reorder helpers', () => {
  const tops = [0, 50, 100, 150];
  const heights = [50, 50, 50, 50];
  it('finds the row under the dragged centre and clamps', () => {
    expect(targetIndex(-20, tops, heights)).toBe(0);
    expect(targetIndex(75, tops, heights)).toBe(1);
    expect(targetIndex(999, tops, heights)).toBe(3);
    expect(targetIndex(10, [], [])).toBe(-1);
  });
  it('shifts the rows between from and to', () => {
    expect(shiftFor(1, 0, 2, 50)).toBe(-50);
    expect(shiftFor(2, 0, 2, 50)).toBe(-50);
    expect(shiftFor(3, 0, 2, 50)).toBe(0);
    expect(shiftFor(1, 3, 1, 50)).toBe(50);
    expect(shiftFor(3, 3, 1, 50)).toBe(0);
    expect(shiftFor(0, 3, 1, 50)).toBe(0);
  });
  it('auto-scrolls only near the edges, faster closer in', () => {
    expect(edgeScroll(300, 0, 600)).toBe(0);
    expect(edgeScroll(10, 0, 600)).toBeLessThan(0);
    expect(edgeScroll(590, 0, 600)).toBeGreaterThan(0);
    expect(Math.abs(edgeScroll(0, 0, 600))).toBeGreaterThan(Math.abs(edgeScroll(60, 0, 600)));
  });
});
