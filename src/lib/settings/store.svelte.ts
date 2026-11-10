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
  MAX_PREFETCH_TRACKS,
  START_SCREENS,
  TRANSCODE_CODECS,
  type AppearanceSettings,
  type AppSettings,
  type BehaviorSettings,
  type Density,
  type DiscordButtonTemplate,
  type DiscordSettings,
  type StreamingSettings,
  type ThemeMode,
} from './types';

export const SETTINGS_KEY = 'settings';

export type SettingsEngine = Pick<Ipc, 'setOutput' | 'setDsp'>;

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

export function parseStreaming(j: unknown): StreamingSettings {
  const o: Json = isObj(j) ? j : {};
  const d = DEFAULT_STREAMING;
  return {
    codec: enumOf(TRANSCODE_CODECS, o.codec, d.codec),
    adaptive: bool(o.adaptive, d.adaptive),
    prefetchTracks: Math.trunc(clampNum(o.prefetchTracks, 0, MAX_PREFETCH_TRACKS, d.prefetchTracks)),
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
    this.current = loadSettings(raw);
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
      await this.engine.setDsp(s.dsp);
    });
  }

  /**
   * The setting is persisted even when the engine rejects it; the failure is
   * reported through `errors`.
   */
  async updateDsp(change: Change<DspConfig>): Promise<void> {
    this.set({ ...this.current, dsp: applyChange(this.current.dsp, change) });
    const dsp = this.current.dsp;
    await this.errors.guard(() => this.engine.setDsp(dsp));
    this.save();
  }

  async setOutput(deviceId: string | null, exclusive: boolean): Promise<void> {
    this.set({ ...this.current, outputDeviceId: deviceId, exclusive });
    await this.errors.guard(() => this.engine.setOutput(deviceId, exclusive));
    this.save();
  }

  async setMaxBitrate(bitsPerSecond: number | null): Promise<void> {
    this.set({ ...this.current, maxBitrate: bitsPerSecond });
    this.save();
  }

  async updateStreaming(change: Change<StreamingSettings>): Promise<void> {
    this.set({ ...this.current, streaming: parseStreaming(applyChange(this.current.streaming, change)) });
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
