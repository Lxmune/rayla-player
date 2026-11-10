import { describe, expect, it } from 'vitest';
import { hueFor, initials, previewServer } from './avatar';

describe('avatar helpers', () => {
  it('builds initials', () => {
    expect(initials('ann')).toBe('AN');
    expect(initials('Ann Lee')).toBe('AL');
    expect(initials('  ')).toBe('?');
    expect(initials('jo.van-dyke')).toBe('JD');
  });
  it('hue is stable and in range', () => {
    expect(hueFor('ann')).toBe(hueFor('ann'));
    expect(hueFor('ann')).toBeGreaterThanOrEqual(0);
    expect(hueFor('some long name')).toBeLessThan(360);
  });
  it('previews the address with the assumed scheme', () => {
    expect(previewServer('')).toBe('');
    expect(previewServer('jf.test:8096')).toBe('http://jf.test:8096');
    expect(previewServer('https://jf.test')).toBe('https://jf.test');
  });
});
