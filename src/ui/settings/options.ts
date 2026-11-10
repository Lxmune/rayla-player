// Option lists shared by the settings sections and the quick Audio sheet.

const BITRATES = [null, 1411000, 320000, 256000, 192000, 160000, 128000, 96000, 64000] as const;

/** Streaming bitrate cap; 'original' = no cap (no transcoding). */
export const BITRATE_OPTIONS = BITRATES.map((b) => ({
  value: b === null ? 'original' : String(b),
  label:
    b === null ? 'Original (no transcoding)' : b === 1411000 ? '1411 kbps (CD)' : `${b / 1000} kbps`,
}));

export const bitrateValue = (b: number | null): string => (b === null ? 'original' : String(b));
export const parseBitrate = (v: string): number | null => (v === 'original' ? null : Number(v));

export const REPLAY_GAIN_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'track', label: 'Track' },
  { value: 'album', label: 'Album' },
];

export const CROSSFEED_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export const CODEC_OPTIONS = [
  { value: 'aac', label: 'AAC (better at low bitrates)' },
  { value: 'mp3', label: 'MP3 (most compatible)' },
  { value: 'flac', label: 'FLAC (lossless, CD quality)' },
];

export const PREFETCH_OPTIONS = [0, 1, 2, 3, 4, 5].map((n) => ({
  value: String(n),
  label: n === 0 ? 'Off' : `${n} track${n === 1 ? '' : 's'}`,
}));

export const CACHE_LIMIT_OPTIONS = [512, 1024, 2048, 3072, 5120, 10240, 20480, 51200].map((mb) => ({
  value: String(mb),
  label: mb < 1024 ? `${mb} MB` : `${mb / 1024} GB`,
}));
