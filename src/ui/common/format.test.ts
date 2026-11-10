import { describe, expect, it } from 'vitest';
import { formatTime, nameGradient, nameHue, plural } from './format';

describe('format', () => {
  it('formats times and plurals', () => {
    expect(formatTime(65000)).toBe('1:05');
    expect(formatTime(3661000)).toBe('1:01:01');
    expect(plural(1, 'track')).toBe('1 track');
    expect(plural(2, 'track')).toBe('2 tracks');
  });

  it('derives a stable hue and gradient from a name', () => {
    expect(nameHue('Jazz')).toBe(nameHue('Jazz'));
    expect(nameHue('Jazz')).toBeGreaterThanOrEqual(0);
    expect(nameHue('Jazz')).toBeLessThan(360);
    expect(nameGradient('Jazz')).toBe(nameGradient('Jazz'));
    expect(nameGradient('Jazz')).not.toBe(nameGradient('Rock'));
    expect(nameGradient('')).toContain('linear-gradient');
  });
});
