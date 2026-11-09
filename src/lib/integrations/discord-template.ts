import type { DiscordButton, SignalPath } from '../ipc';
import type { DiscordSettings } from '../settings/types';
import { PLACEHOLDER_DISCORD_APP_ID } from '../settings/types';
import type { TrackMeta } from '../track-meta';

/** Placeholder name -> value. Unknown names stay verbatim; null renders empty. */
export type TemplateVars = Record<string, string | null>;

export function hasRealApplicationId(s: Pick<DiscordSettings, 'applicationId'>): boolean {
  const id = s.applicationId.trim();
  return id !== '' && id !== PLACEHOLDER_DISCORD_APP_ID;
}

/** Replaces `{name}` with `vars[name]`. Unknown placeholders stay verbatim so typos are
 *  visible in the preview; null values render as empty. */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(vars, key) ? (vars[key] ?? '') : whole,
  );
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function khz(hz: number): string {
  const k = hz / 1000;
  return Number.isInteger(k) ? String(k) : k.toFixed(1);
}

interface FormatSource {
  codec: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
}

/** "FLAC 24/96", or "MP3 44.1 kHz" when there is no integer bit depth. */
function formatOf(f: FormatSource): string {
  if (!f.codec || !f.sampleRate) return '';
  const codec = f.codec.toUpperCase();
  return f.bitDepth ? `${codec} ${f.bitDepth}/${khz(f.sampleRate)}` : `${codec} ${khz(f.sampleRate)} kHz`;
}

export function formatSignal(p: SignalPath | null): string {
  return p ? formatOf({ codec: p.codec, sampleRate: p.sourceSampleRate, bitDepth: p.sourceBitDepth }) : '';
}

export function trimBaseUrl(publicUrl: string): string {
  return publicUrl.trim().replace(/\/+$/, '');
}

export interface DiscordVarsInput {
  meta: TrackMeta;
  /** Preferred over meta for format/codec/rate/bitDepth when given. */
  signal?: SignalPath | null;
  positionMs: number;
  durationMs: number;
  publicUrl?: string;
}

/** Placeholder values for one moment of playback. */
export function discordVars(i: DiscordVarsInput): TemplateVars {
  const { meta, signal } = i;
  const src: FormatSource = signal
    ? { codec: signal.codec, sampleRate: signal.sourceSampleRate, bitDepth: signal.sourceBitDepth }
    : { codec: meta.codec, sampleRate: meta.sampleRate, bitDepth: meta.bitDepth };
  const artist = meta.artists.length > 0 ? meta.artists.join(', ') : (meta.albumArtist ?? '');
  return {
    title: meta.title,
    artist,
    album: meta.album ?? '',
    albumArtist: meta.albumArtist ?? '',
    year: meta.year === null ? '' : String(meta.year),
    format: formatOf(src),
    codec: src.codec ? src.codec.toUpperCase() : '',
    rate: src.sampleRate ? `${khz(src.sampleRate)} kHz` : '',
    bitDepth: src.bitDepth ? `${src.bitDepth}-bit` : '',
    position: formatClock(i.positionMs),
    duration: formatClock(i.durationMs),
    id: meta.id,
    albumId: meta.albumId ?? '',
    publicUrl: trimBaseUrl(i.publicUrl ?? ''),
  };
}

/** `{publicUrl}/Items/{imageItemId}/Images/Primary`; null without a public URL or image. */
export function coverUrl(meta: TrackMeta, publicUrl: string): string | null {
  const base = trimBaseUrl(publicUrl);
  if (!base || !meta.imageItemId) return null;
  return `${base}/Items/${meta.imageItemId}/Images/Primary`;
}

const clip = (s: string) => (s.length <= 128 ? s : s.slice(0, 128));

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}

export interface RenderedPresence {
  details: string;
  state: string;
  largeText: string;
  smallText: string;
  buttons: DiscordButton[];
}

/** Rendered text for the settings preview and the presence push. Fields are clipped to
 *  128 chars; buttons need a non-empty label and a valid http(s) URL (max 2). */
export function renderPresence(s: DiscordSettings, vars: TemplateVars): RenderedPresence {
  const buttons: DiscordButton[] = [];
  for (const b of s.buttons.slice(0, 2)) {
    const label = clip(renderTemplate(b.label, vars).trim());
    const url = renderTemplate(b.url, vars).trim();
    if (label && isHttpUrl(url)) buttons.push({ label, url });
  }
  return {
    details: clip(renderTemplate(s.details, vars)),
    state: clip(renderTemplate(s.state, vars)),
    largeText: clip(renderTemplate(s.largeText, vars)),
    smallText: clip(renderTemplate(s.smallText, vars)),
    buttons,
  };
}
