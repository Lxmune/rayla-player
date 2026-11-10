import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDecoded, preloadImage, resetImageCache } from './image-cache';

class FakeImage {
  static made = 0;
  static fail = new Set<string>();
  decoding = '';
  srcset = '';
  src = '';
  constructor() {
    FakeImage.made += 1;
  }
  decode(): Promise<void> {
    return FakeImage.fail.has(this.src) ? Promise.reject(new Error('bad')) : Promise.resolve();
  }
}

describe('image cache', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetImageCache();
    FakeImage.made = 0;
    FakeImage.fail.clear();
  });

  it('decodes once and remembers it', async () => {
    vi.stubGlobal('Image', FakeImage);
    const s = { src: 'a.jpg', srcset: 'a1.jpg 1x, a.jpg 2x' };
    expect(isDecoded(s)).toBe(false);
    expect(await preloadImage(s)).toBe(true);
    expect(isDecoded(s)).toBe(true);
    expect(await preloadImage(s)).toBe(true);
    expect(FakeImage.made).toBe(1);
  });

  it('a failed decode is not cached, so it is retried', async () => {
    vi.stubGlobal('Image', FakeImage);
    FakeImage.fail.add('b.jpg');
    expect(await preloadImage({ src: 'b.jpg' })).toBe(false);
    expect(isDecoded({ src: 'b.jpg' })).toBe(false);
    FakeImage.fail.clear();
    expect(await preloadImage({ src: 'b.jpg' })).toBe(true);
    expect(FakeImage.made).toBe(2);
  });
});
