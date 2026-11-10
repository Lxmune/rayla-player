// Settings sections in display order, with the search keywords for each.

export interface SectionInfo {
  id: string;
  label: string;
  /** Extra words the search matches besides the label. */
  keywords: string;
}

export const SECTIONS: SectionInfo[] = [
  { id: 'appearance', label: 'Appearance', keywords: 'theme dark light system accent colour color cover density compact backdrop motion animation' },
  { id: 'behavior', label: 'Playback & behavior', keywords: 'resume restore queue start screen home startup' },
  { id: 'output', label: 'Output', keywords: 'device audio exclusive wasapi coreaudio dac speakers bit-perfect sample rate' },
  { id: 'gain', label: 'Volume & gain', keywords: 'volume replaygain replay gain preamp clip guard limiter loudness' },
  { id: 'eq', label: 'Equalizer', keywords: 'eq parametric autoeq band filter headphones peak shelf' },
  { id: 'processing', label: 'Processing', keywords: 'dsp convolution impulse response crossfeed compressor dynamics loudness resample dither crossfade gapless bit-perfect' },
  { id: 'streaming', label: 'Streaming', keywords: 'bitrate transcode quality dsd dop pcm' },
  { id: 'scrobbling', label: 'Scrobbling', keywords: 'listenbrainz last.fm lastfm scrobble history token' },
  { id: 'discord', label: 'Discord', keywords: 'rich presence activity application id status' },
  { id: 'about', label: 'About', keywords: 'version shortcuts keyboard help rayla' },
];

/** Sections matching every word of `query` (all of them for an empty query). */
export function matchSections(query: string): SectionInfo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return SECTIONS;
  return SECTIONS.filter((s) => {
    const hay = `${s.label} ${s.keywords}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
