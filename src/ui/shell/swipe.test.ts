import { describe, expect, it } from 'vitest';
import { classifySwipe } from './swipe';

describe('classifySwipe', () => {
  it('detects taps, swipe up and sideways swipes', () => {
    expect(classifySwipe(2, -3)).toBe('tap');
    expect(classifySwipe(5, -50)).toBe('up');
    expect(classifySwipe(-80, 10)).toBe('left');
    expect(classifySwipe(80, -10)).toBe('right');
  });
  it('ignores short drags and swipes down', () => {
    expect(classifySwipe(30, 0)).toBe('none');
    expect(classifySwipe(0, 60)).toBe('none');
    expect(classifySwipe(60, 80)).toBe('none');
  });
});
