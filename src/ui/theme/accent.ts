// Accent colour extraction from cover pixels. Pure; the canvas/fetch plumbing
// lives in `loadAccent`.

export interface Accent {
  /** `#rrggbb` */
  accent: string;
  /** Readable text colour on `accent` (`#111111` or `#ffffff`). */
  contrast: string;
}

export type AccentMode = 'dark' | 'light';

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const hex = (rgb: [number, number, number]) =>
  `#${rgb.map((v) => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')).join('')}`;

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** `#111111` or `#ffffff`, whichever contrasts more with `rgb`. */
export function contrastFor(rgb: [number, number, number]): string {
  const L = luminance(rgb);
  const vsDark = (L + 0.05) / (luminance([17, 17, 17]) + 0.05);
  const vsLight = 1.05 / (L + 0.05);
  return vsDark >= vsLight ? '#111111' : '#ffffff';
}

/** Parses `#rgb` / `#rrggbb`; null when invalid. */
export function parseHex(value: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  let h = m[1] as string;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * Turns a user-chosen colour into a usable accent: lightness is nudged only as
 * far as needed to read on the theme background (dark: not too dark, light: not
 * too bright), and a matching text colour is derived. Null for invalid input.
 */
export function accentFromHex(value: string, mode: AccentMode = 'dark'): Accent | null {
  const rgb = parseHex(value);
  if (!rgb) return null;
  const [h, s, l] = rgbToHsl(...rgb);
  const target = mode === 'dark' ? Math.max(l, 0.5) : Math.min(l, 0.46);
  const out = target === l ? rgb : hslToRgb(h, s, target);
  return { accent: hex(out), contrast: contrastFor(out) };
}

const BUCKETS = 12;
const MIN_SATURATION = 0.28;
/** Share of opaque pixels that must be colourful, else the cover counts as grey. */
const MIN_COLOURFUL_SHARE = 0.03;

/**
 * Picks a vibrant accent from RGBA pixels: the hue bucket with the most
 * saturated, mid-lightness weight wins; its colour is then normalised so it
 * reads on the theme background. Null for (near) greyscale or empty images.
 */
export function pickAccent(rgba: Uint8ClampedArray, mode: AccentMode = 'dark'): Accent | null {
  const weight = new Float64Array(BUCKETS);
  const sx = new Float64Array(BUCKETS);
  const sy = new Float64Array(BUCKETS);
  const sat = new Float64Array(BUCKETS);
  let opaque = 0;
  let colourful = 0;

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < 128) continue;
    opaque++;
    const [h, s, l] = rgbToHsl(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
    if (s < MIN_SATURATION || l < 0.12 || l > 0.92) continue;
    colourful++;
    // Favour saturated mid-tones.
    const w = s * (1 - Math.abs(2 * l - 1) * 0.7);
    const b = Math.min(BUCKETS - 1, Math.floor(h / (360 / BUCKETS)));
    const rad = (h * Math.PI) / 180;
    weight[b] = (weight[b] ?? 0) + w;
    sx[b] = (sx[b] ?? 0) + Math.cos(rad) * w;
    sy[b] = (sy[b] ?? 0) + Math.sin(rad) * w;
    sat[b] = (sat[b] ?? 0) + s * w;
  }

  if (opaque === 0 || colourful / opaque < MIN_COLOURFUL_SHARE) return null;

  let best = 0;
  for (let b = 1; b < BUCKETS; b++) if ((weight[b] ?? 0) > (weight[best] ?? 0)) best = b;
  const w = weight[best] ?? 0;
  if (w <= 0) return null;

  let hue = (Math.atan2(sy[best] ?? 0, sx[best] ?? 0) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  const avgSat = (sat[best] ?? 0) / w;
  const s = Math.min(0.85, Math.max(0.5, avgSat));
  const l = mode === 'dark' ? 0.68 : 0.42;
  const rgb = hslToRgb(hue, s, l);
  return { accent: hex(rgb), contrast: contrastFor(rgb) };
}

/** Downscaled pixel grid used for extraction. */
const SAMPLE = 48;

/**
 * Fetches `url` (through `fetch`, which must bypass CORS so the canvas stays
 * untainted), decodes it and runs `pickAccent`. Null on any failure.
 */
export async function loadAccent(
  url: string,
  fetchFn: (url: string) => Promise<Response>,
  mode: AccentMode,
): Promise<Accent | null> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, SAMPLE, SAMPLE);
    bitmap.close?.();
    return pickAccent(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data, mode);
  } catch {
    return null;
  }
}
