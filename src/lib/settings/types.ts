// FROZEN: persisted app settings shape and defaults. The settings store
// (src/lib/settings/store.ts) owns parsing, persistence and engine pushes.

import type { CompressorConfig, DspConfig } from '../ipc';

export type ThemeMode = 'dark' | 'light' | 'system';

/** Placeholder Discord application id: users create their own app at
 *  https://discord.com/developers/applications with assets `rayla`, `play`, `pause`. */
export const PLACEHOLDER_DISCORD_APP_ID = '000000000000000000';

/** Usable in every Discord template field as `{name}`. */
export const DISCORD_PLACEHOLDERS = [
  'title', 'artist', 'album', 'albumArtist', 'year', 'format', 'codec',
  'rate', 'bitDepth', 'position', 'duration',
] as const;
/** Additionally usable in button label/URL templates. */
export const DISCORD_LINK_PLACEHOLDERS = ['id', 'albumId', 'publicUrl'] as const;

export interface DiscordButtonTemplate {
  label: string;
  url: string;
}

export interface DiscordSettings {
  enabled: boolean;
  applicationId: string;
  details: string;
  state: string;
  largeText: string;
  smallText: string;
  showElapsed: boolean;
  showWhenPaused: boolean;
  /** Needs publicUrl: Discord fetches the image itself. */
  showCover: boolean;
  /** Public base URL of the Jellyfin server. */
  publicUrl: string;
  /** Always two slots; empty ones are not sent. */
  buttons: [DiscordButtonTemplate, DiscordButtonTemplate];
}

export type Density = 'comfortable' | 'compact';

export interface AppearanceSettings {
  /** Tint the UI with a colour taken from the current cover. */
  accentFromCover: boolean;
  /** Accent used when nothing plays or cover tinting is off (#rrggbb). */
  accentColor: string;
  density: Density;
  /** Blurred cover art behind now playing and detail headers. */
  artBackdrop: boolean;
  /** Turns animations off (they are also off when the OS asks for reduced motion). */
  reduceMotion: boolean;
}

export const START_SCREENS = ['home', 'albums', 'artists', 'playlists', 'favorites'] as const;
export type StartScreen = (typeof START_SCREENS)[number];

export interface BehaviorSettings {
  /** Restore the queue and position (paused) on the next start. */
  resumePlayback: boolean;
  startScreen: StartScreen;
}

export interface AppSettings {
  /** null = system default device. */
  outputDeviceId: string | null;
  exclusive: boolean;
  /** Streaming bitrate cap in bits/s; null = original file. */
  maxBitrate: number | null;
  dsp: DspConfig;
  themeMode: ThemeMode;
  appearance: AppearanceSettings;
  behavior: BehaviorSettings;
  scrobbleListenBrainz: boolean;
  scrobbleLastFm: boolean;
  discord: DiscordSettings;
}

export const DEFAULT_COMPRESSOR: CompressorConfig = {
  enabled: false,
  thresholdDb: -18,
  ratio: 3,
  attackMs: 10,
  releaseMs: 150,
  makeupDb: 0,
};

export const DEFAULT_DSP: DspConfig = {
  volume: 1,
  replayGain: 'off',
  preampDb: 0,
  clipGuard: true,
  eqEnabled: false,
  eqPreampDb: 0,
  eqBands: [],
  convolutionPath: null,
  crossfeed: 'off',
  compressor: DEFAULT_COMPRESSOR,
  resampleTo: null,
  dither: 'off',
  crossfadeMs: 0,
  dsd: 'dop',
};

export const DEFAULT_DISCORD: DiscordSettings = {
  enabled: false,
  applicationId: PLACEHOLDER_DISCORD_APP_ID,
  details: '{title}',
  state: '{artist} - {album}',
  largeText: '{album}',
  smallText: '{format}',
  showElapsed: true,
  showWhenPaused: true,
  showCover: false,
  publicUrl: '',
  buttons: [
    { label: '', url: '' },
    { label: '', url: '' },
  ],
};

export const DEFAULT_ACCENT = '#c9a7ff';

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  accentFromCover: true,
  accentColor: DEFAULT_ACCENT,
  density: 'comfortable',
  artBackdrop: true,
  reduceMotion: false,
};

export const DEFAULT_BEHAVIOR: BehaviorSettings = {
  resumePlayback: true,
  startScreen: 'home',
};

export const DEFAULT_SETTINGS: AppSettings = {
  outputDeviceId: null,
  exclusive: false,
  maxBitrate: null,
  dsp: DEFAULT_DSP,
  themeMode: 'dark',
  appearance: DEFAULT_APPEARANCE,
  behavior: DEFAULT_BEHAVIOR,
  scrobbleListenBrainz: false,
  scrobbleLastFm: false,
  discord: DEFAULT_DISCORD,
};
