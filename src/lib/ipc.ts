// FROZEN CONTRACT between the Svelte frontend and the Rust backend
// (src-tauri). Rust structs use #[serde(rename_all = "camelCase")] and unit
// enums #[serde(rename_all = "camelCase")], so the JSON shapes below are exact.
// Tauri maps camelCase invoke argument keys to snake_case Rust parameters.
// Change deliberately and update both sides together.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { MediaAction, NowPlayingInfo } from './android';

// ---------------------------------------------------------------- engine types

export interface HttpHeader {
  name: string;
  value: string;
}

/**
 * One track to play. The engine downloads the whole file into its stream cache in
 * the background (keyed by `id` + `url`), so playback survives network drops.
 */
export interface TrackRequest {
  id: string;
  /** Opaque queue-entry id chosen by the frontend; echoed on every event. */
  entryId: string;
  url: string;
  headers: HttpHeader[];
  /** Play this local file instead of `url` when set (offline download). */
  localPath: string | null;
  /** Picks album gain; suppresses crossfade inside one album. */
  albumId: string | null;
  /** Jellyfin gain, used only when the file has no ReplayGain tags. */
  fallbackGainDb: number | null;
}

export interface OutputDevice {
  id: string;
  name: string;
  isDefault: boolean;
  supportsExclusive: boolean;
  sampleRates: number[];
  maxBitDepth: number;
}

export type PlaybackState = 'stopped' | 'buffering' | 'playing' | 'paused';
export type ReplayGainMode = 'off' | 'track' | 'album';
export type EqBandKind = 'peak' | 'lowShelf' | 'highShelf';
export type CrossfeedLevel = 'off' | 'low' | 'medium' | 'high';
export type DitherMode = 'off' | 'tpdf' | 'shaped';
/** `dop`: DSD over PCM when exclusive + DSP bypassed + device supports the
 *  carrier rate, else falls back to PCM. `pcm`: always convert to 352.8 kHz. */
export type DsdMode = 'dop' | 'pcm';

export interface EqBand {
  kind: EqBandKind;
  freqHz: number;
  gainDb: number;
  q: number;
}

/** Downward compressor (after crossfeed, before resampling). */
export interface CompressorConfig {
  enabled: boolean;
  /** dBFS above which gain is reduced. */
  thresholdDb: number;
  /** ≥ 1 (n:1). */
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

/** All off/empty with volume 1.0 = bit-perfect passthrough. */
export interface DspConfig {
  /** 0.0 ..= 1.0 */
  volume: number;
  replayGain: ReplayGainMode;
  preampDb: number;
  clipGuard: boolean;
  eqEnabled: boolean;
  eqPreampDb: number;
  eqBands: EqBand[];
  /** WAV impulse response; null disables convolution. */
  convolutionPath: string | null;
  crossfeed: CrossfeedLevel;
  compressor: CompressorConfig;
  /** Force output rate; null = source rate (or nearest supported in exclusive). */
  resampleTo: number | null;
  dither: DitherMode;
  /** 0 disables. Never applied between tracks of one album. */
  crossfadeMs: number;
  dsd: DsdMode;
}

export interface SignalPath {
  codec: string;
  sourceSampleRate: number;
  /** 0 for lossy / float sources. */
  sourceBitDepth: number;
  channels: number;
  /** Human-readable active stages in order, e.g. "ReplayGain -6.2 dB". */
  stages: string[];
  deviceName: string;
  outputSampleRate: number;
  outputBitDepth: number;
  exclusive: boolean;
  bitPerfect: boolean;
}

export type EventKind =
  | 'stateChanged'
  | 'position' // ~5 Hz, positionMs/durationMs for trackId
  | 'trackStarted' // trackId became audible (also on gapless advance)
  | 'trackEnded' // trackId played to its end
  | 'signalPathChanged'
  | 'error' // message, for trackId/entryId when set
  | 'throughput' // throughputBps measured while fetching trackId into the cache
  | 'fetchProgress'; // cachedBytes/totalBytes of trackId's stream-cache entry (~2 Hz while downloading, once when complete)

export interface EngineEvent {
  kind: EventKind;
  state: PlaybackState;
  trackId: string | null;
  entryId: string | null;
  positionMs: number;
  durationMs: number;
  signalPath: SignalPath | null;
  message: string | null;
  /** Network rate in bits/s; set on `throughput` events, else 0. */
  throughputBps: number;
  /** Bytes of trackId in the stream cache; set on `fetchProgress` events, else 0. */
  cachedBytes: number;
  /** Full size; 0 = unknown (chunked transcode) or not a `fetchProgress` event. */
  totalBytes: number;
}

export interface CacheStats {
  usedBytes: number;
  limitBytes: number;
  /** Cached tracks (complete or partial). */
  entries: number;
}

export interface DiscordButton {
  label: string;
  url: string;
}

/** Already rendered from templates. Empty strings / null leave a field out. */
export interface DiscordActivity {
  details: string;
  state: string;
  /** Asset key or public https URL. */
  largeImage: string | null;
  largeText: string | null;
  smallImage: string | null;
  smallText: string | null;
  /** Unix epoch ms. */
  startTimestampMs: number | null;
  endTimestampMs: number | null;
  /** At most two are sent. */
  buttons: DiscordButton[];
  /** Text after "Listening to" in Discord's member list: 0 = app name, 1 = state,
   *  2 = details. null = Discord's default (app name). */
  statusDisplayType: 0 | 1 | 2 | null;
}

// ------------------------------------------------------------ downloads types

/** A fully downloaded track (only complete files are listed). */
export interface DownloadRecord {
  id: string;
  /** Absolute path, usable as TrackRequest.localPath. */
  path: string;
  bytes: number;
  /** ISO-8601. */
  addedAt: string;
  /** Opaque JSON the frontend stored with the download (the Jellyfin item). */
  item: unknown;
}

export interface DownloadRequest {
  id: string;
  url: string;
  headers: HttpHeader[];
  /** File extension without dot, e.g. "flac"; sanitized by Rust. */
  extension: string;
  item: unknown;
}

export interface DownloadProgress {
  id: string;
  receivedBytes: number;
  totalBytes: number | null;
}

// ------------------------------------------------------------------ commands

export const ENGINE_EVENT = 'engine://event';
export const DOWNLOAD_PROGRESS_EVENT = 'downloads://progress';
/** Desktop OS media controls (SMTC / MPNowPlayingInfoCenter / MPRIS); same payload as Android's. */
export const MEDIA_ACTION_EVENT = 'media://action';

export const ipc = {
  /** Null when the engine started, else why it failed (shown as a banner). */
  engineInitError: () => invoke<string | null>('engine_init_error'),
  listDevices: () => invoke<OutputDevice[]>('engine_list_devices'),
  /** deviceId null = system default. Failures arrive as `error` events. */
  setOutput: (deviceId: string | null, exclusive: boolean) =>
    invoke<void>('engine_set_output', { deviceId, exclusive }),
  /** Replaces the current track and clears the queued next track. */
  load: (track: TrackRequest, startPlaying: boolean) =>
    invoke<void>('engine_load', { track, startPlaying }),
  /** Track to continue with gaplessly when the current one ends. */
  setNext: (track: TrackRequest | null) => invoke<void>('engine_set_next', { track }),
  /**
   * Download these tracks fully into the stream cache in the background, in order,
   * one at a time. Replaces the previous list; tracks no longer listed are dropped.
   */
  prefetch: (tracks: TrackRequest[]) => invoke<void>('engine_prefetch', { tracks }),
  /** Stream-cache usage. */
  cacheStats: () => invoke<CacheStats>('engine_cache_stats'),
  /** Deletes every stream-cache entry not currently in use (offline downloads are separate). */
  cacheClear: () => invoke<void>('engine_cache_clear'),
  /** Stream-cache size cap in bytes; prunes least recently used entries now. */
  cacheSetLimit: (bytes: number) => invoke<void>('engine_cache_set_limit', { bytes }),
  /** Ids of the given tracks whose stream-cache entry is complete (cache key = id + url). */
  cachedTracks: (tracks: TrackRequest[]) => invoke<string[]>('engine_cached_tracks', { tracks }),
  play: () => invoke<void>('engine_play'),
  pause: () => invoke<void>('engine_pause'),
  stop: () => invoke<void>('engine_stop'),
  seek: (positionMs: number) => invoke<void>('engine_seek', { positionMs }),
  setDsp: (config: DspConfig) => invoke<void>('engine_set_dsp', { config }),
  onEngineEvent: (cb: (e: EngineEvent) => void): Promise<UnlistenFn> =>
    listen<EngineEvent>(ENGINE_EVENT, (e) => cb(e.payload)),

  /** Show or clear (null) Rich Presence. Discord not running is not an error. */
  discordSetActivity: (applicationId: string, activity: DiscordActivity | null) =>
    invoke<void>('discord_set_activity', { applicationId, activity }),

  /** Desktop OS media controls (media keys, Windows SMTC, macOS Now Playing, Linux MPRIS). */
  mediaUpdateNowPlaying: (info: NowPlayingInfo) => invoke<void>('media_update_now_playing', { info }),
  mediaClearNowPlaying: () => invoke<void>('media_clear_now_playing'),
  onMediaAction: (cb: (a: MediaAction) => void): Promise<UnlistenFn> =>
    listen<MediaAction>(MEDIA_ACTION_EVENT, (e) => cb(e.payload)),

  /** OS keychain. value null/empty deletes. */
  secretGet: (key: string) => invoke<string | null>('secret_get', { key }),
  secretSet: (key: string, value: string | null) => invoke<void>('secret_set', { key, value }),

  downloadsList: () => invoke<DownloadRecord[]>('downloads_list'),
  /** Resolves when the file is complete and indexed; rejects on failure/cancel. */
  downloadsStart: (request: DownloadRequest) =>
    invoke<DownloadRecord>('downloads_start', { request }),
  downloadsCancel: (id: string) => invoke<void>('downloads_cancel', { id }),
  downloadsDelete: (id: string) => invoke<void>('downloads_delete', { id }),
  /**
   * Folder for new offline downloads (null = app default). Existing files stay where they
   * are (records keep their paths); the index stays in app data.
   */
  downloadsSetDir: (dir: string | null) => invoke<void>('downloads_set_dir', { dir }),
  onDownloadProgress: (cb: (p: DownloadProgress) => void): Promise<UnlistenFn> =>
    listen<DownloadProgress>(DOWNLOAD_PROGRESS_EVENT, (e) => cb(e.payload)),
};

export type Ipc = typeof ipc;
