// Option lists shared by the settings sections and the quick Audio sheet.

const BITRATES = [null, 320000, 256000, 192000, 128000] as const;

/** Streaming bitrate cap; 'original' = no cap (no transcoding). */
export const BITRATE_OPTIONS = BITRATES.map((b) => ({
  value: b === null ? 'original' : String(b),
  label: b === null ? 'Original (no transcoding)' : `${b / 1000} kbps`,
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
