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

export const START_SCREENS = ['home', 'discover', 'albums', 'artists', 'playlists', 'favorites'] as const;
export type StartScreen = (typeof START_SCREENS)[number];

export interface BehaviorSettings {
  /** Restore the queue and position (paused) on the next start. */
  resumePlayback: boolean;
  startScreen: StartScreen;
}

export const TRANSCODE_CODECS = ['aac', 'mp3', 'flac'] as const;
/**
 * What the server transcodes to when the bitrate cap applies (AAC is ADTS). `flac` =
 * lossless CD quality (FLAC, at most 16-bit / 48 kHz) for sources above the cap;
 * effective caps below 1411 kbps (e.g. adaptive) fall back to AAC.
 */
export type TranscodeCodec = (typeof TRANSCODE_CODECS)[number];

export const MAX_PREFETCH_TRACKS = 5;

export interface StreamingSettings {
  codec: TranscodeCodec;
  /** Lower the cap for upcoming tracks while the measured connection is slow. */
  adaptive: boolean;
  /** Queue tracks after the next one downloaded fully ahead of time, 0..MAX_PREFETCH_TRACKS. */
  prefetchTracks: number;
  /** Stream-cache size cap in MB, CACHE_LIMITS_MB range. */
  cacheLimitMb: number;
  /** On mobile data (Android cellular), cap streaming at `mobileMaxBitrate` instead of `maxBitrate`. */
  mobileCapEnabled: boolean;
  /** bits/s; null = original. Used only when mobileCapEnabled and on mobile data. */
  mobileMaxBitrate: number | null;
}

export const CROSSFADE_MODES = ['always', 'shuffle'] as const;
/** `shuffle`: crossfade only while shuffling or playing a radio (never inside one album either way). */
export type CrossfadeMode = (typeof CROSSFADE_MODES)[number];

export interface PlaybackSettings {
  crossfadeMode: CrossfadeMode;
  /** Remember the position of tracks at least this many minutes long; 0 = off. */
  resumeLongTracksMin: number;
  /** The sleep timer fades the volume out over its last minute. */
  sleepFadeOut: boolean;
}

export interface DownloadSettings {
  /** Start/continue offline downloads only on Wi-Fi / Ethernet (Android). */
  wifiOnly: boolean;
  /** Folder for new offline downloads; null = app default. See android.ts listStorageVolumes. */
  dir: string | null;
}

export const CACHE_LIMIT_MIN_MB = 256;
export const CACHE_LIMIT_MAX_MB = 51_200;

export interface AppSettings {
  /** null = system default device. */
  outputDeviceId: string | null;
  exclusive: boolean;
  /** Streaming bitrate cap in bits/s; null = original file. */
  maxBitrate: number | null;
  streaming: StreamingSettings;
  dsp: DspConfig;
  /** When on, each output device keeps its own DSP chain in `deviceDsp`. */
  perDeviceDsp: boolean;
  /** Output device id ('' = system default) -> its DSP chain. */
  deviceDsp: Record<string, DspConfig>;
  playback: PlaybackSettings;
  downloads: DownloadSettings;
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

export const DEFAULT_STREAMING: StreamingSettings = {
  codec: 'aac',
  adaptive: false,
  prefetchTracks: 2,
  cacheLimitMb: 3072,
  mobileCapEnabled: false,
  mobileMaxBitrate: 320_000,
};

export const DEFAULT_PLAYBACK: PlaybackSettings = {
  crossfadeMode: 'always',
  resumeLongTracksMin: 20,
  sleepFadeOut: true,
};

export const DEFAULT_DOWNLOADS: DownloadSettings = {
  wifiOnly: false,
  dir: null,
};

export const DEFAULT_SETTINGS: AppSettings = {
  outputDeviceId: null,
  exclusive: false,
  maxBitrate: null,
  streaming: DEFAULT_STREAMING,
  dsp: DEFAULT_DSP,
  perDeviceDsp: false,
  deviceDsp: {},
  playback: DEFAULT_PLAYBACK,
  downloads: DEFAULT_DOWNLOADS,
  themeMode: 'dark',
  appearance: DEFAULT_APPEARANCE,
  behavior: DEFAULT_BEHAVIOR,
  scrobbleListenBrainz: false,
  scrobbleLastFm: false,
  discord: DEFAULT_DISCORD,
};
