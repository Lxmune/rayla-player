import { describe, expect, it } from 'vitest';
import { effectiveMaxBitrate, ewma } from './adaptive';

describe('effectiveMaxBitrate', () => {
  it('is the user cap when adaptive is off or unmeasured', () => {
    expect(effectiveMaxBitrate(null, false, 100_000)).toBeNull();
    expect(effectiveMaxBitrate(256_000, false, 100_000)).toBe(256_000);
    expect(effectiveMaxBitrate(null, true, null)).toBeNull();
  });
  it('steps down with the rate', () => {
    expect(effectiveMaxBitrate(null, true, 5_000_000)).toBeNull();
    expect(effectiveMaxBitrate(null, true, 3_000_000)).toBeNull();
    expect(effectiveMaxBitrate(null, true, 2_000_000)).toBe(320_000);
    expect(effectiveMaxBitrate(null, true, 800_000)).toBe(192_000);
    expect(effectiveMaxBitrate(null, true, 400_000)).toBe(128_000);
    expect(effectiveMaxBitrate(null, true, 100_000)).toBe(96_000);
  });
  it('never exceeds the user cap', () => {
    expect(effectiveMaxBitrate(128_000, true, 2_000_000)).toBe(128_000);
    expect(effectiveMaxBitrate(256_000, true, 100_000)).toBe(96_000);
    expect(effectiveMaxBitrate(64_000, true, 100_000)).toBe(64_000);
    expect(effectiveMaxBitrate(192_000, true, 9_000_000)).toBe(192_000);
  });
});

describe('ewma', () => {
  it('ignores zero samples and smooths others', () => {
    expect(ewma(null, 0)).toBeNull();
    expect(ewma(1000, 0)).toBe(1000);
    expect(ewma(null, 1000)).toBe(1000);
    expect(ewma(1000, 2000)).toBeCloseTo(1300);
  });
});
