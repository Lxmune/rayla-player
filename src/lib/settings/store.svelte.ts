// App settings: parsed defensively from KeyValueStore JSON, persisted on every
// change, pushed to the engine where relevant.

import type {
  CompressorConfig,
  CrossfeedLevel,
  DitherMode,
  DspConfig,
  DsdMode,
  EqBand,
  EqBandKind,
  Ipc,
  ReplayGainMode,
} from '../ipc';
import type { KeyValueStore } from '../platform';
import { EngineErrors } from '../player/errors.svelte';
import {
  DEFAULT_APPEARANCE,
  DEFAULT_BEHAVIOR,
  DEFAULT_COMPRESSOR,
  DEFAULT_DISCORD,
  DEFAULT_DSP,
  DEFAULT_SETTINGS,
  DEFAULT_STREAMING,
  DEFAULT_PLAYBACK,
  DEFAULT_DOWNLOADS,
  DOWNLOAD_QUALITIES,
  CROSSFADE_MODES,
  MAX_PREFETCH_TRACKS,
  CACHE_LIMIT_MAX_MB,
  CACHE_LIMIT_MIN_MB,
  START_SCREENS,
  TRANSCODE_CODECS,
  type AppearanceSettings,
  type AppSettings,
  type BehaviorSettings,
  type Density,
  type DiscordButtonTemplate,
  type DiscordSettings,
  type DownloadSettings,
  type PlaybackSettings,
  type StreamingSettings,
  type ThemeMode,
} from './types';

export const SETTINGS_KEY = 'settings';

const deviceKey = (id: string | null): string => id ?? '';
const cacheBytes = (mb: number): number => mb * 1024 * 1024;

export type SettingsEngine = Pick<Ipc, 'setOutput' | 'setDsp' | 'cacheSetLimit' | 'cacheStats' | 'cacheClear'>;

// ----------------------------------------------------------------- parsing

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const strOr = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Unknown / missing enum values fall back (like Dart `_enum`). */
function enumOf<T extends string>(values: readonly T[], v: unknown, fallback: T): T {
  return values.find((x) => x === v) ?? fallback;
}

const REPLAY_GAIN: readonly ReplayGainMode[] = ['off', 'track', 'album'];
const EQ_KINDS: readonly EqBandKind[] = ['peak', 'lowShelf', 'highShelf'];
const CROSSFEED: readonly CrossfeedLevel[] = ['off', 'low', 'medium', 'high'];
const DITHER: readonly DitherMode[] = ['off', 'tpdf', 'shaped'];
const DSD: readonly DsdMode[] = ['dop', 'pcm'];
const THEMES: readonly ThemeMode[] = ['dark', 'light', 'system'];
const DENSITIES: readonly Density[] = ['comfortable', 'compact'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = num(v);
  return n === null ? fallback : Math.min(hi, Math.max(lo, n));
};

export function parseCompressor(j: unknown): CompressorConfig {
  const o: Json = isObj(j) ? j : {};
  const d = DEFAULT_COMPRESSOR;
  return {
    enabled: bool(o.enabled, d.enabled),
    thresholdDb: clampNum(o.thresholdDb, -60, 0, d.thresholdDb),
    ratio: clampNum(o.ratio, 1, 20, d.ratio),
    attackMs: clampNum(o.attackMs, 0.1, 200, d.attackMs),
    releaseMs: clampNum(o.releaseMs, 10, 2000, d.releaseMs),
    makeupDb: clampNum(o.makeupDb, 0, 24, d.makeupDb),
  };
}

export function parseDsp(j: unknown): DspConfig {
  const o: Json = isObj(j) ? j : {};
  const bands: EqBand[] = [];
  if (Array.isArray(o.eqBands)) {
    for (const b of o.eqBands) {
      if (!isObj(b)) continue;
      const freqHz = num(b.freqHz);
      const gainDb = num(b.gainDb);
      const q = num(b.q);
      if (freqHz === null || gainDb === null || q === null) continue;
      bands.push({ kind: enumOf(EQ_KINDS, b.kind, 'peak'), freqHz, gainDb, q });
    }
  }
  const resample = num(o.resampleTo);
  const crossfade = num(o.crossfadeMs);
  return {
    volume: num(o.volume) ?? DEFAULT_DSP.volume,
    replayGain: enumOf(REPLAY_GAIN, o.replayGain, 'off'),
    preampDb: num(o.preampDb) ?? 0,
    clipGuard: bool(o.clipGuard, true),
    eqEnabled: bool(o.eqEnabled, false),
    eqPreampDb: num(o.eqPreampDb) ?? 0,
    eqBands: bands,
    convolutionPath: strOrNull(o.convolutionPath),
    crossfeed: enumOf(CROSSFEED, o.crossfeed, 'off'),
    compressor: parseCompressor(o.compressor),
    resampleTo: resample === null ? null : Math.trunc(resample),
    dither: enumOf(DITHER, o.dither, 'off'),
    crossfadeMs: crossfade === null ? 0 : Math.trunc(crossfade),
    dsd: enumOf(DSD, o.dsd, 'dop'),
  };
}

function parseButton(v: unknown): DiscordButtonTemplate {
  const o: Json = isObj(v) ? v : {};
  return { label: strOr(o.label, ''), url: strOr(o.url, '') };
}

export function parseDiscord(j: unknown): DiscordSettings {
  const o: Json = isObj(j) ? j : {};
  const d = DEFAULT_DISCORD;
  const raw = Array.isArray(o.buttons) ? o.buttons : [];
  return {
    enabled: bool(o.enabled, d.enabled),
    applicationId: strOr(o.applicationId, d.applicationId),
    details: strOr(o.details, d.details),
    state: strOr(o.state, d.state),
    largeText: strOr(o.largeText, d.largeText),
    smallText: strOr(o.smallText, d.smallText),
    showElapsed: bool(o.showElapsed, d.showElapsed),
    showWhenPaused: bool(o.showWhenPaused, d.showWhenPaused),
    showCover: bool(o.showCover, d.showCover),
    publicUrl: strOr(o.publicUrl, d.publicUrl),
    // Always two slots, padded with empty ones.
    buttons: [parseButton(raw[0]), parseButton(raw[1])],
  };
}

export function parseAppearance(j: unknown): AppearanceSettings {
  const o: Json = isObj(j) ? j : {};
  const d = DEFAULT_APPEARANCE;
  const color = strOr(o.accentColor, d.accentColor);
  return {
    accentFromCover: bool(o.accentFromCover, d.accentFromCover),
    accentColor: HEX_COLOR.test(color) ? color.toLowerCase() : d.accentColor,
    density: enumOf(DENSITIES, o.density, d.density),
    artBackdrop: bool(o.artBackdrop, d.artBackdrop),
    reduceMotion: bool(o.reduceMotion, d.reduceMotion),
  };
}

export function parseBehavior(j: unknown): BehaviorSettings {
  const o: Json = isObj(j) ? j : {};
  const d = DEFAULT_BEHAVIOR;
  return {
    resumePlayback: bool(o.resumePlayback, d.resumePlayback),
    startScreen: enumOf(START_SCREENS, o.startScreen, d.startScreen),
  };
}

/** null = original; a positive number of bits/s; anything else falls back. */
function parseMobileBitrate(v: unknown, fallback: number | null): number | null {
  if (v === null) return null;
  const n = num(v);
  return n !== null && n >= 1000 ? Math.trunc(n) : fallback;
}

export function parseStreaming(j: unknown): StreamingSettings {
  const o: Json = isObj(j) ? j : {};
  const d = DEFAULT_STREAMING;
  return {
    codec: enumOf(TRANSCODE_CODECS, o.codec, d.codec),
    adaptive: bool(o.adaptive, d.adaptive),
    prefetchTracks: Math.trunc(clampNum(o.prefetchTracks, 0, MAX_PREFETCH_TRACKS, d.prefetchTracks)),
    cacheLimitMb: Math.trunc(clampNum(o.cacheLimitMb, CACHE_LIMIT_MIN_MB, CACHE_LIMIT_MAX_MB, d.cacheLimitMb)),
    mobileCapEnabled: bool(o.mobileCapEnabled, d.mobileCapEnabled),
    mobileMaxBitrate: parseMobileBitrate(o.mobileMaxBitrate, d.mobileMaxBitrate),
  };
}

export function parsePlayback(j: unknown): PlaybackSettings {
  const o: Json = isObj(j) ? j : {};
  const d = DEFAULT_PLAYBACK;
  return {
    crossfadeMode: enumOf(CROSSFADE_MODES, o.crossfadeMode, d.crossfadeMode),
    resumeLongTracksMin: Math.trunc(clampNum(o.resumeLongTracksMin, 0, 600, d.resumeLongTracksMin)),
    sleepFadeOut: bool(o.sleepFadeOut, d.sleepFadeOut),
  };
}

export function parseDownloads(j: unknown): DownloadSettings {
  const o: Json = isObj(j) ? j : {};
  return {
    quality: enumOf(DOWNLOAD_QUALITIES, o.quality, DEFAULT_DOWNLOADS.quality),
    wifiOnly: bool(o.wifiOnly, DEFAULT_DOWNLOADS.wifiOnly),
    dir: strOrNull(o.dir),
  };
}

export function parseSettings(j: unknown): AppSettings {
  const o: Json = isObj(j) ? j : {};
  const maxBitrate = num(o.maxBitrate);
  return {
    outputDeviceId: strOrNull(o.outputDeviceId),
    exclusive: bool(o.exclusive, DEFAULT_SETTINGS.exclusive),
    maxBitrate: maxBitrate === null ? null : Math.trunc(maxBitrate),
    streaming: parseStreaming(o.streaming),
    dsp: parseDsp(o.dsp),
    perDeviceDsp: bool(o.perDeviceDsp, false),
    deviceDsp: Object.fromEntries(
      Object.entries(isObj(o.deviceDsp) ? o.deviceDsp : {}).map(([k, v]) => [k, parseDsp(v)]),
    ),
    playback: parsePlayback(o.playback),
    downloads: parseDownloads(o.downloads),
    themeMode: enumOf(THEMES, o.themeMode, 'dark'),
    appearance: parseAppearance(o.appearance),
    behavior: parseBehavior(o.behavior),
    scrobbleListenBrainz: bool(o.scrobbleListenBrainz, false),
    scrobbleLastFm: bool(o.scrobbleLastFm, false),
    discord: parseDiscord(o.discord),
  };
}

/** Reads settings from a stored JSON string; anything unusable yields defaults. */
export function loadSettings(raw: string | null): AppSettings {
  if (raw === null) return parseSettings(null);
  try {
    return parseSettings(JSON.parse(raw));
  } catch {
    return parseSettings(null);
  }
}

// ------------------------------------------------------------------- store

export interface SettingsStoreDeps {
  kv: KeyValueStore;
  engine: SettingsEngine;
  errors: EngineErrors;
}

type Change<T> = Partial<T> | ((current: T) => T);
const applyChange = <T extends object>(current: T, change: Change<T>): T =>
  typeof change === 'function' ? change(current) : { ...current, ...change };

export class SettingsStore {
  /** Current settings. Replaced (never mutated) on every change. */
  current = $state.raw<AppSettings>(DEFAULT_SETTINGS);

  private readonly kv: KeyValueStore;
  private readonly engine: SettingsEngine;
  private readonly errors: EngineErrors;
  private readonly listeners = new Set<(s: AppSettings, prev: AppSettings) => void>();
  /** Whether crossfade may run right now (the `shuffle` crossfade mode). Wired by the core. */
  private crossfadeAllowed: () => boolean = () => true;
  /** Transient volume factor (sleep-timer fade); never saved. */
  private volumeScale = 1;
  /** Serialised DSP last sent to the engine; null until the first push. */
  private lastPushed: string | null = null;

  constructor(deps: SettingsStoreDeps) {
    this.kv = deps.kv;
    this.engine = deps.engine;
    this.errors = deps.errors;
    let raw: string | null = null;
    try {
      raw = this.kv.get(SETTINGS_KEY);
    } catch {
      // unreadable storage: defaults
    }
    const loaded = loadSettings(raw);
    const mine = loaded.perDeviceDsp ? loaded.deviceDsp[deviceKey(loaded.outputDeviceId)] : undefined;
    this.current = mine ? { ...loaded, dsp: mine } : loaded;
  }

  /** The chain sent to the engine: the active one, minus a gated crossfade, times the transient volume scale. */
  effectiveDsp(): DspConfig {
    const s = this.current;
    let dsp = s.dsp;
    if (s.playback.crossfadeMode === 'shuffle' && !this.crossfadeAllowed() && dsp.crossfadeMs !== 0) {
      dsp = { ...dsp, crossfadeMs: 0 };
    }
    if (this.volumeScale !== 1) dsp = { ...dsp, volume: dsp.volume * this.volumeScale };
    return dsp;
  }

  /** Supplies the "crossfade allowed" predicate (shuffling or radio). Call `refreshDsp` when it changes. */
  setCrossfadeGate(allowed: () => boolean): void {
    this.crossfadeAllowed = allowed;
  }

  /** Re-sends the DSP chain when the effective one changed (gate, volume scale). No-op before startup. */
  async refreshDsp(): Promise<void> {
    if (this.lastPushed === null) return;
    if (JSON.stringify(this.effectiveDsp()) === this.lastPushed) return;
    await this.pushDsp();
  }

  private async pushDsp(): Promise<void> {
    const dsp = this.effectiveDsp();
    this.lastPushed = JSON.stringify(dsp);
    await this.errors.guard(() => this.engine.setDsp(dsp));
  }

  /** Scales the engine volume for a while (1 = none). Not persisted. */
  setVolumeScale(scale: number): Promise<void> {
    this.volumeScale = Math.min(1, Math.max(0, scale));
    return this.refreshDsp();
  }

  /** Called synchronously after each change. Returns an unsubscribe function. */
  onChange(listener: (s: AppSettings, prev: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(next: AppSettings): void {
    const prev = this.current;
    this.current = next;
    for (const l of [...this.listeners]) l(next, prev);
  }

  private save(): void {
    try {
      this.kv.set(SETTINGS_KEY, JSON.stringify(this.current));
    } catch (e) {
      this.errors.report(e);
    }
  }

  /** Pushes output selection and the DSP chain to the engine (on startup). */
  async pushToEngine(): Promise<void> {
    const s = this.current;
    await this.errors.guard(async () => {
      await this.engine.setOutput(s.outputDeviceId, s.exclusive);
      await this.engine.setDsp(this.effectiveDsp());
      this.lastPushed = JSON.stringify(this.effectiveDsp());
      await this.engine.cacheSetLimit(cacheBytes(s.streaming.cacheLimitMb));
    });
  }

  /** Stream-cache usage reported by the engine. */
  cacheStats() {
    return this.engine.cacheStats();
  }

  /** Empties the stream cache (offline downloads are separate files). */
  clearCache() {
    return this.engine.cacheClear();
  }

  /**
   * The setting is persisted even when the engine rejects it; the failure is
   * reported through `errors`.
   */
  async updateDsp(change: Change<DspConfig>): Promise<void> {
    const s = this.current;
    const dsp = applyChange(s.dsp, change);
    const deviceDsp = s.perDeviceDsp ? { ...s.deviceDsp, [deviceKey(s.outputDeviceId)]: dsp } : s.deviceDsp;
    this.set({ ...s, dsp, deviceDsp });
    await this.pushDsp();
    this.save();
  }

  /** Turns separate per-output DSP chains on/off. Turning on seeds the active device from the current chain. */
  async setPerDeviceDsp(on: boolean): Promise<void> {
    const s = this.current;
    if (s.perDeviceDsp === on) return;
    const deviceDsp = on ? { ...s.deviceDsp, [deviceKey(s.outputDeviceId)]: s.dsp } : s.deviceDsp;
    this.set({ ...s, perDeviceDsp: on, deviceDsp });
    this.save();
  }

  async setOutput(deviceId: string | null, exclusive: boolean): Promise<void> {
    const s = this.current;
    let next: AppSettings = { ...s, outputDeviceId: deviceId, exclusive };
    const swap = s.perDeviceDsp && deviceKey(deviceId) !== deviceKey(s.outputDeviceId);
    if (swap) {
      const known = s.deviceDsp[deviceKey(deviceId)];
      const dsp = known ?? s.dsp; // first use of a device: seed from the current chain
      next = { ...next, dsp, deviceDsp: { ...s.deviceDsp, [deviceKey(deviceId)]: dsp } };
    }
    this.set(next);
    await this.errors.guard(async () => {
      await this.engine.setOutput(deviceId, exclusive);
    });
    if (swap) await this.pushDsp();
    this.save();
  }

  async updatePlayback(change: Change<PlaybackSettings>): Promise<void> {
    this.set({ ...this.current, playback: parsePlayback(applyChange(this.current.playback, change)) });
    await this.refreshDsp();
    this.save();
  }

  async setMaxBitrate(bitsPerSecond: number | null): Promise<void> {
    this.set({ ...this.current, maxBitrate: bitsPerSecond });
    this.save();
  }

  async updateStreaming(change: Change<StreamingSettings>): Promise<void> {
    const prevLimit = this.current.streaming.cacheLimitMb;
    this.set({ ...this.current, streaming: parseStreaming(applyChange(this.current.streaming, change)) });
    const limit = this.current.streaming.cacheLimitMb;
    if (limit !== prevLimit) {
      await this.errors.guard(() => this.engine.cacheSetLimit(cacheBytes(limit)));
    }
    this.save();
  }

  async setThemeMode(mode: ThemeMode): Promise<void> {
    this.set({ ...this.current, themeMode: mode });
    this.save();
  }

  async updateAppearance(change: Change<AppearanceSettings>): Promise<void> {
    this.set({ ...this.current, appearance: parseAppearance(applyChange(this.current.appearance, change)) });
    this.save();
  }

  async updateBehavior(change: Change<BehaviorSettings>): Promise<void> {
    this.set({ ...this.current, behavior: parseBehavior(applyChange(this.current.behavior, change)) });
    this.save();
  }

  async updateDownloads(change: Change<DownloadSettings>): Promise<void> {
    this.set({ ...this.current, downloads: parseDownloads(applyChange(this.current.downloads, change)) });
    this.save();
  }

  async setScrobbleListenBrainz(enabled: boolean): Promise<void> {
    this.set({ ...this.current, scrobbleListenBrainz: enabled });
    this.save();
  }

  async setScrobbleLastFm(enabled: boolean): Promise<void> {
    this.set({ ...this.current, scrobbleLastFm: enabled });
    this.save();
  }

  async updateDiscord(change: Change<DiscordSettings>): Promise<void> {
    this.set({ ...this.current, discord: applyChange(this.current.discord, change) });
    this.save();
  }
}
