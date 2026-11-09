import { describe, expect, it } from 'vitest';
import { contrastFor, pickAccent } from './accent';

function pixels(n: number, rgba: [number, number, number, number]): number[] {
  return Array.from({ length: n }, () => rgba).flat();
}
const img = (...parts: number[][]) => new Uint8ClampedArray(parts.flat());

function parse(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

describe('pickAccent', () => {
  it('returns null for greyscale, empty and fully transparent images', () => {
    expect(pickAccent(img(pixels(100, [128, 128, 128, 255])))).toBeNull();
    expect(pickAccent(new Uint8ClampedArray())).toBeNull();
    expect(pickAccent(img(pixels(100, [255, 0, 0, 0])))).toBeNull();
  });

  it('ignores near-black and near-white even when saturated', () => {
    expect(pickAccent(img(pixels(100, [20, 0, 0, 255])))).toBeNull();
    expect(pickAccent(img(pixels(100, [255, 235, 235, 255])))).toBeNull();
  });

  it('picks the dominant vibrant hue', () => {
    const a = pickAccent(img(pixels(80, [200, 30, 40, 255]), pixels(20, [30, 60, 200, 255])));
    expect(a).not.toBeNull();
    const [r, g, b] = parse(a!.accent);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it('ignores a grey background around a small colourful area', () => {
    const a = pickAccent(img(pixels(90, [100, 100, 100, 255]), pixels(10, [40, 190, 80, 255])));
    expect(a).not.toBeNull();
    const [r, g, b] = parse(a!.accent);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('is readable: light enough on dark, darker on light, valid hex and contrast', () => {
    const data = img(pixels(50, [30, 120, 220, 255]));
    const dark = pickAccent(data, 'dark')!;
    const light = pickAccent(data, 'light')!;
    expect(dark.accent).toMatch(/^#[0-9a-f]{6}$/);
    const lum = (hex: string) => {
      const [r, g, b] = parse(hex);
      return 0.299 * r + 0.587 * g + 0.114 * b;
    };
    expect(lum(dark.accent)).toBeGreaterThan(lum(light.accent));
    expect(['#111111', '#ffffff']).toContain(dark.contrast);
    expect(dark.contrast).toBe(contrastFor(parse(dark.accent)));
  });

  it('contrastFor picks dark text on bright and light text on dark colours', () => {
    expect(contrastFor([255, 255, 100])).toBe('#111111');
    expect(contrastFor([20, 20, 120])).toBe('#ffffff');
  });
});
