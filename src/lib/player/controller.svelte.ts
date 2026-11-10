// Queue + playback controller. Dart owns queue order and Jellyfin reporting;
// the Rust engine plays "URL + headers" and tells us what it is doing through
// EngineEvents (matched back to queue entries by entry id).

import type {
  EngineEvent,
  EventKind,
  Ipc,
  PlaybackState,
  SignalPath,
  TrackRequest,
} from '../ipc';
import type { JellyfinClient, PlaybackExtra } from '../jellyfin/client';
import {
  itemDurationMs,
  toTrackMeta,
  willTranscode,
  type BaseItem,
} from '../jellyfin/models';
import type { NetworkType } from '../android';
import type { AppSettings, TranscodeCodec } from '../settings/types';
import type { TrackMeta } from '../track-meta';
import { effectiveMaxBitrate, ewma } from './adaptive';
import type { EngineErrors } from './errors.svelte';

/** Fetches more tracks for a radio from the most recently played ones. */
export type RadioSource = (recent: BaseItem[]) => Promise<BaseItem[]>;

/** Tracks left after the current one at or below which a radio asks for more. */
const RADIO_LOW_WATER = 3;
const RADIO_RECENT = 50;

/** Cap (bits/s) from which lossless FLAC (16-bit / 48 kHz) fits. */
export const FLAC_MIN_CAP = 1_411_000;

export type RepeatMode = 'off' | 'all' | 'one';
const REPEAT_ORDER: readonly RepeatMode[] = ['off', 'all', 'one'];

/** A queue slot. `uid` keeps duplicates of the same track distinct. */
export interface QueueEntry {
  readonly uid: number;
  readonly item: BaseItem;
}

export type PlayerEngine = Pick<
  Ipc,
  'load' | 'setNext' | 'prefetch' | 'play' | 'pause' | 'stop' | 'seek' | 'onEngineEvent'
>;

export interface PlayerSettings {
  readonly current: AppSettings;
  onChange(listener: (s: AppSettings, prev: AppSettings) => void): () => void;
}

export interface PlayerDownloads {
  /** Local file of a fully downloaded track, or null. */
  pathFor(itemId: string): string | null;
  isDownloaded(itemId: string): boolean;
}

/** Network type source (Android bridge; tests use a fake). */
export interface NetworkSource {
  get(): Promise<NetworkType>;
  /** Subscribes to changes; returns (a promise of) the unsubscribe function. */
  onChange(cb: (type: NetworkType) => void): Promise<() => void> | (() => void);
}

/** Remembered positions of long tracks (per profile; the core backs it with kv). */
export interface LongResumeStore {
  get(itemId: string): number | null;
  /** `null` forgets the track. */
  set(itemId: string, positionMs: number | null): void;
}

const LONG_RESUME_THROTTLE_MS = 10_000;
/** A long track finished when within this much of its end. */
const LONG_RESUME_DONE_MS = 30_000;

export interface PlayerDeps {
  engine: PlayerEngine;
  /** The active Jellyfin client, or null when signed out. */
  client: () => JellyfinClient | null;
  settings: PlayerSettings;
  downloads: PlayerDownloads;
  errors: EngineErrors;
  /** Uniform [0,1). Default Math.random. */
  random?: () => number;
  /** Epoch ms. Default Date.now. */
  now?: () => number;
  network?: NetworkSource;
  longResume?: LongResumeStore;
}

/** An engine event together with the queue entry it refers to. */
export interface PlayerEvent {
  kind: EventKind;
  state: PlaybackState;
  /** Engine entry id (`"<uid>"` or `"<uid>~<n>"` for a repeat). */
  entryId: string | null;
  /** The queue entry the event refers to (the current one when the event carries no entry id). */
  entry: QueueEntry | null;
  item: BaseItem | null;
  /** `toTrackMeta(item)`. */
  meta: TrackMeta | null;
  positionMs: number;
  durationMs: number;
  signalPath: SignalPath | null;
  message: string | null;
}

const SEEK_GUARD_MS = 1500;
const SEEK_NEAR_MS = 1000;
const PROGRESS_INTERVAL_MS = 10_000;

export class PlayerController {
  /** Play order (already shuffled when `shuffle` is on). Replaced, never mutated. */
  queue = $state.raw<QueueEntry[]>([]);
  /** Index of the current entry in `queue`, -1 when nothing is loaded. */
  index = $state(-1);
  shuffle = $state(false);
  repeat = $state<RepeatMode>('off');
  playback = $state<PlaybackState>('stopped');
  positionMs = $state(0);
  durationMs = $state(0);
  signalPath = $state.raw<SignalPath | null>(null);

  current = $derived<BaseItem | null>(
    this.index >= 0 && this.index < this.queue.length ? (this.queue[this.index]?.item ?? null) : null,
  );
  currentEntry = $derived<QueueEntry | null>(
    this.index >= 0 && this.index < this.queue.length ? (this.queue[this.index] ?? null) : null,
  );
  isPlaying = $derived(this.playback === 'playing');
  /** Smoothed download rate in bits/s from `throughput` events; null until measured. */
  throughputBps = $state<number | null>(null);
  /** Index that plays after the current track ends on its own. */
  nextIndex = $derived.by<number | null>(() => {
    if (this.index < 0 || this.queue.length === 0) return null;
    if (this.repeat === 'one') return this.index;
    if (this.index + 1 < this.queue.length) return this.index + 1;
    return this.repeat === 'all' ? 0 : null;
  });

  /** Current connection type; only `cellular` is metered. */
  networkType = $state<NetworkType>('other');

  /** Active radio (auto-extending queue), or null. */
  radio = $state.raw<{ label: string } | null>(null);
  private radioSource: RadioSource | null = null;
  private radioBusy = false;
  private radioFailures = 0;

  private readonly deps: PlayerDeps;
  /**
   * Bitrate cap for upcoming tracks: the user's cap, lowered by the measured
   * connection speed when adaptive streaming is on. null = original file.
   */
  effectiveMaxBitrate = $derived.by<number | null>(() => this.effectiveCap(this.deps.settings.current));
  private lastPrefetchKey: string | null = null;
  private readonly random: () => number;
  private readonly now: () => number;
  private seekGuard: { target: number; until: number } | null = null;
  private original: QueueEntry[] = [];
  private nextUid = 0;
  private nextRepeat = 0;
  /** Engine entry id of the track the engine is playing (or loading). */
  private currentEntryId: string | null = null;
  /**
   * Entry id used for the repeat of the current entry; stable until it starts
   * so re-arming does not make the engine reopen the same track.
   */
  private repeatEntryId: string | null = null;
  /** Position a restored (not yet loaded) track starts at on the first play(). */
  private pendingSeekMs: number | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(e: PlayerEvent) => void>();
  private unlisten: (() => void) | null = null;
  private attaching: Promise<void> | null = null;
  private unsubSettings: () => void;
  private unsubNetwork: (() => void) | null = null;
  private disposed = false;
  /** Long-track resume bookkeeping. */
  private longTrack: { id: string; durationMs: number } | null = null;
  private lastLongSave = 0;

  // Jellyfin reporting.
  private reportedId: string | null = null;
  private reportedTranscoding = false;
  private lastProgress = 0;

  constructor(deps: PlayerDeps) {
    this.deps = deps;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.lastProgress = this.now();
    // A new effective bitrate cap or codec changes the URL of upcoming tracks; the
    // prefetch depth changes which ones are fetched ahead.
    this.unsubSettings = deps.settings.onChange((s, prev) => {
      if (this.current === null) return;
      if (
        this.effectiveCap(s) !== this.effectiveCap(prev) ||
        s.streaming.codec !== prev.streaming.codec
      ) {
        void this.armNext();
      } else if (s.streaming.prefetchTracks !== prev.streaming.prefetchTracks) {
        void this.syncPrefetch();
      }
    });
    void this.watchNetwork();
  }

  private async watchNetwork(): Promise<void> {
    const net = this.deps.network;
    if (!net) return;
    const apply = (type: NetworkType) => {
      const before = this.effectiveMaxBitrate;
      this.networkType = type;
      if (this.current !== null && this.effectiveMaxBitrate !== before) void this.armNext();
    };
    try {
      apply(await net.get());
      const un = await net.onChange(apply);
      if (this.disposed) un();
      else this.unsubNetwork = un;
    } catch {
      // no network info: stay on the plain cap
    }
  }

  /** The codec of the URL: FLAC only while the effective cap leaves room for CD quality. */
  private streamCodec(): TranscodeCodec {
    const codec = this.deps.settings.current.streaming.codec;
    if (codec !== 'flac') return codec;
    const cap = this.effectiveMaxBitrate;
    return cap !== null && cap >= FLAC_MIN_CAP ? 'flac' : 'aac';
  }

  private effectiveCap(s: AppSettings, throughput = this.throughputBps): number | null {
    const mobile = this.networkType === 'cellular' && s.streaming.mobileCapEnabled;
    return effectiveMaxBitrate(
      mobile ? s.streaming.mobileMaxBitrate : s.maxBitrate,
      s.streaming.adaptive,
      throughput,
    );
  }

  /** Subscribes to engine events. Idempotent; call once at startup. */
  attach(): Promise<void> {
    this.attaching ??= this.deps.engine
      .onEngineEvent((e) => this.handleEvent(e))
      .then((un) => {
        this.unlisten = un;
      })
      .catch((e: unknown) => {
        this.attaching = null;
        this.deps.errors.report(e);
      });
    return this.attaching;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubNetwork?.();
    this.unsubNetwork = null;
    this.unlisten?.();
    this.unlisten = null;
    this.attaching = null;
    this.unsubSettings();
  }

  /**
   * Listen to every engine event, resolved against the queue (after the
   * controller itself processed it). Returns an unsubscribe function.
   */
  onEngineEvent(listener: (e: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ------------------------------------------------------------- public API

  /**
   * Replaces the queue and starts `startIndex`. With `shuffle` undefined the
   * current shuffle setting is kept.
   */
  playQueue(
    tracks: BaseItem[],
    opts: { startIndex?: number; shuffle?: boolean } = {},
  ): Promise<void> {
    if (tracks.length === 0) return Promise.resolve();
    this.endRadio();
    const entries = tracks.map((item) => this.entry(item));
    const shuf = opts.shuffle ?? this.shuffle;
    const start = clamp(opts.startIndex ?? 0, 0, entries.length - 1);
    this.original = entries;
    let order = entries;
    let index = start;
    if (shuf) {
      const first = entries[start];
      order = first ? [first, ...this.shuffled(entries, start)] : entries;
      index = 0;
    }
    this.queue = order;
    this.index = index;
    this.shuffle = shuf;
    return this.loadIndex(index);
  }

  /**
   * Fetches an instant mix seeded from `seed` (track, album, artist, ...) and
   * plays it. Returns the number of tracks (0: nothing was started).
   */
  async playInstantMix(seed: BaseItem, limit = 50): Promise<number> {
    const client = this.deps.client();
    if (!client) return 0;
    const mix = await client.instantMix(seed.id, limit);
    if (mix.length === 0) return 0;
    await this.playQueue(mix, { startIndex: 0 });
    return mix.length;
  }

  /**
   * Plays `seed` and keeps the queue topped up with `more(recent)` while
   * repeat is off. Any call that replaces the queue ends the radio.
   */
  playRadio(seed: BaseItem[], more: RadioSource, label: string): Promise<void> {
    if (seed.length === 0) return Promise.resolve();
    const started = this.playQueue(seed, { startIndex: 0 });
    this.radio = { label };
    this.radioSource = more;
    this.radioFailures = 0;
    this.maybeExtendRadio();
    return started;
  }

  /** Keeps the queue, stops extending it. */
  stopRadio(): void {
    this.endRadio();
  }

  private endRadio(): void {
    this.radio = null;
    this.radioSource = null;
    this.radioFailures = 0;
  }

  private maybeExtendRadio(): void {
    const more = this.radioSource;
    if (!more || this.radioBusy || this.repeat !== 'off') return;
    if (this.index < 0 || this.queue.length - 1 - this.index > RADIO_LOW_WATER) return;
    const recent = this.queue
      .slice(Math.max(0, this.index + 1 - RADIO_RECENT), this.index + 1)
      .map((e) => e.item);
    this.radioBusy = true;
    void (async () => {
      let fresh: BaseItem[] = [];
      let failed = false;
      try {
        const got = await more(recent);
        const have = new Set(this.queue.map((e) => e.item.id));
        for (const item of got) {
          if (have.has(item.id)) continue;
          have.add(item.id);
          fresh.push(item);
        }
        failed = fresh.length === 0;
      } catch {
        failed = true;
        fresh = [];
      }
      this.radioBusy = false;
      if (this.radioSource !== more) return; // radio ended or replaced meanwhile
      if (failed) {
        this.radioFailures += 1;
        if (this.radioFailures >= 2) {
          this.endRadio();
          this.deps.errors.report('Radio could not find more tracks and stopped.');
        }
        return;
      }
      this.radioFailures = 0;
      const entries = fresh.map((item) => this.entry(item));
      this.original = [...this.original, ...entries];
      this.queue = [...this.queue, ...entries];
      void this.armNext();
    })();
  }

  /**
   * Puts a saved queue back without starting audio: the engine is untouched,
   * the first play() loads the track and seeks to `positionMs`.
   */
  restore(snap: {
    items: BaseItem[];
    index: number;
    positionMs: number;
    shuffle: boolean;
    repeat: RepeatMode;
  }): void {
    if (snap.items.length === 0) return;
    this.endRadio();
    const entries = snap.items.map((item) => this.entry(item));
    const index = clamp(snap.index, 0, entries.length - 1);
    this.original = entries;
    this.queue = entries;
    this.index = index;
    this.shuffle = snap.shuffle;
    this.repeat = snap.repeat;
    this.playback = 'stopped';
    this.durationMs = itemDurationMs(entries[index]?.item as BaseItem);
    this.positionMs = Math.max(0, snap.positionMs);
    this.pendingSeekMs = this.positionMs;
    this.signalPath = null;
    this.currentEntryId = null;
    this.repeatEntryId = null;
  }

  playNext(tracks: BaseItem[]): Promise<void> {
    const cur = this.currentEntry;
    if (!cur) return this.playQueue(tracks);
    const entries = tracks.map((item) => this.entry(item));
    const queue = [...this.queue];
    queue.splice(this.index + 1, 0, ...entries);
    const origAt = this.original.findIndex((e) => e.uid === cur.uid);
    const original = [...this.original];
    original.splice(origAt < 0 ? original.length : origAt + 1, 0, ...entries);
    this.original = original;
    this.queue = queue;
    return this.armNext();
  }

  addToQueue(tracks: BaseItem[]): Promise<void> {
    if (!this.current) return this.playQueue(tracks);
    const entries = tracks.map((item) => this.entry(item));
    this.original = [...this.original, ...entries];
    this.queue = [...this.queue, ...entries];
    return this.armNext();
  }

  removeAt(i: number): Promise<void> {
    if (i < 0 || i >= this.queue.length) return Promise.resolve();
    const removed = this.queue[i];
    const queue = [...this.queue];
    queue.splice(i, 1);
    this.original = this.original.filter((e) => e.uid !== removed?.uid);
    if (queue.length === 0) return this.clear();
    if (i === this.index) {
      const wasPlaying = this.playback !== 'paused';
      const next = clamp(i, 0, queue.length - 1);
      this.reportStopped();
      this.queue = queue;
      this.index = next;
      return this.loadIndex(next, wasPlaying);
    }
    this.queue = queue;
    if (i < this.index) this.index -= 1;
    return this.armNext();
  }

  /** Removes every entry after the current one. */
  removeUpcoming(): Promise<void> {
    if (this.index < 0 || this.index >= this.queue.length - 1) return Promise.resolve();
    const queue = this.queue.slice(0, this.index + 1);
    const alive = new Set(queue.map((e) => e.uid));
    this.original = this.original.filter((e) => alive.has(e.uid));
    this.queue = queue;
    return this.armNext();
  }

  /** `newIndex` is the final position of the moved entry. */
  reorder(oldIndex: number, newIndex: number): Promise<void> {
    if (oldIndex < 0 || oldIndex >= this.queue.length) return Promise.resolve();
    newIndex = clamp(newIndex, 0, this.queue.length - 1);
    if (newIndex === oldIndex) return Promise.resolve();
    const currentUid = this.currentEntry?.uid;
    const queue = [...this.queue];
    const [moved] = queue.splice(oldIndex, 1);
    if (!moved) return Promise.resolve();
    queue.splice(newIndex, 0, moved);
    if (!this.shuffle) this.original = queue;
    this.queue = queue;
    this.index = queue.findIndex((e) => e.uid === currentUid);
    return this.armNext();
  }

  jumpTo(i: number): Promise<void> {
    if (i < 0 || i >= this.queue.length) return Promise.resolve();
    this.reportStopped();
    this.index = i;
    return this.loadIndex(i);
  }

  toggleShuffle(): Promise<void> {
    const cur = this.currentEntry;
    if (!this.shuffle) {
      if (!cur) {
        this.shuffle = true;
        return Promise.resolve();
      }
      const rest = this.shuffled(this.queue, this.index);
      this.queue = [cur, ...rest];
      this.index = 0;
      this.shuffle = true;
    } else {
      const alive = new Set(this.queue.map((e) => e.uid));
      const queue = this.original.filter((e) => alive.has(e.uid));
      this.queue = queue;
      this.index = cur ? queue.findIndex((e) => e.uid === cur.uid) : -1;
      this.shuffle = false;
    }
    return this.armNext();
  }

  setRepeat(mode: RepeatMode): Promise<void> {
    this.repeat = mode;
    return this.armNext();
  }

  cycleRepeat(): Promise<void> {
    const i = REPEAT_ORDER.indexOf(this.repeat);
    return this.setRepeat(REPEAT_ORDER[(i + 1) % REPEAT_ORDER.length] ?? 'off');
  }

  togglePlay(): Promise<void> {
    if (!this.current) return Promise.resolve();
    if (this.playback === 'playing' || this.playback === 'buffering') return this.pause();
    return this.play();
  }

  play(): Promise<void> {
    if (!this.current) return Promise.resolve();
    if (this.playback === 'stopped') {
      const at = this.pendingSeekMs;
      const loaded = this.loadIndex(this.index);
      if (at !== null && at > 0) return this.seek(at).then(() => loaded);
      return loaded;
    }
    const prev = this.playback;
    this.playback = 'playing'; // optimistic; the engine event confirms
    return this.run(() => this.deps.engine.play(), () => {
      if (this.playback === 'playing') this.playback = prev;
    });
  }

  pause(): Promise<void> {
    const prev = this.playback;
    if (prev === 'stopped') return this.run(() => this.deps.engine.pause());
    this.playback = 'paused'; // optimistic; the engine event confirms
    return this.run(() => this.deps.engine.pause(), () => {
      if (this.playback === 'paused') this.playback = prev;
    });
  }

  next(): Promise<void> {
    if (!this.current) return Promise.resolve();
    let target = this.index + 1;
    if (target >= this.queue.length) {
      if (this.repeat !== 'all') return this.stop();
      target = 0;
    }
    return this.jumpTo(target);
  }

  previous(): Promise<void> {
    if (!this.current) return Promise.resolve();
    if (this.positionMs > 3000) return this.seek(0);
    if (this.index > 0) return this.jumpTo(this.index - 1);
    if (this.repeat === 'all' && this.queue.length > 1) return this.jumpTo(this.queue.length - 1);
    return this.seek(0);
  }

  seek(positionMs: number): Promise<void> {
    if (!this.current) return Promise.resolve();
    this.positionMs = positionMs;
    this.seekGuard = { target: positionMs, until: this.now() + SEEK_GUARD_MS };
    if (this.pendingSeekMs !== null) {
      // Restored but not loaded yet: remember where the first play() starts.
      this.pendingSeekMs = positionMs;
      return Promise.resolve();
    }
    this.reportProgress();
    return this.run(() => this.deps.engine.seek(positionMs));
  }

  stop(): Promise<void> {
    this.flushLong();
    this.longTrack = null;
    this.endRadio();
    this.reportStopped();
    this.playback = 'stopped';
    this.seekGuard = null;
    this.positionMs = 0;
    void this.syncPrefetch(true);
    return this.run(() => this.deps.engine.stop());
  }

  /** Stops playback and empties the queue (used when switching profiles). */
  clear(): Promise<void> {
    this.endRadio();
    this.reportStopped();
    this.original = [];
    this.queue = [];
    this.index = -1;
    this.playback = 'stopped';
    this.durationMs = 0;
    this.signalPath = null;
    this.positionMs = 0;
    this.currentEntryId = null;
    this.repeatEntryId = null;
    this.pendingSeekMs = null;
    void this.syncPrefetch();
    return this.run(() => this.deps.engine.stop());
  }

  /** Pushes the current state to the server now (used after remote commands). */
  reportNow(): void {
    this.reportProgress();
  }

  // -------------------------------------------------------- engine plumbing

  private entry(item: BaseItem): QueueEntry {
    return { uid: this.nextUid++, item };
  }

  /**
   * The engine's id for a queue slot. Playing the same slot again right after
   * itself (repeat one, or a one-track repeat-all queue) needs a distinct id,
   * or its start could not be told from the load confirmation.
   */
  private entryId(i: number): string {
    const uid = this.queue[i]?.uid;
    if (i !== this.index) return `${uid}`;
    return (this.repeatEntryId ??= `${uid}~${this.nextRepeat++}`);
  }

  /** Queue slot an engine entry id refers to, or -1. */
  private indexOfEntry(entryId: string | null): number {
    const uid = Number.parseInt((entryId ?? '').split('~')[0] ?? '', 10);
    return Number.isNaN(uid) ? -1 : this.queue.findIndex((q) => q.uid === uid);
  }

  /** Engine commands run strictly one after another; failures are reported, never thrown. */
  private run(call: () => Promise<unknown>, onFail?: () => void): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await call();
      } catch (e) {
        onFail?.();
        this.deps.errors.report(e);
      }
    });
    return this.chain;
  }

  private request(i: number | null, entryId: string): TrackRequest | null {
    const client = this.deps.client();
    if (i === null || !client) return null;
    const item = this.queue[i]?.item;
    if (!item) return null;
    return {
      id: item.id,
      entryId,
      url: client.streamUrl(item.id, {
        maxBitrate: this.effectiveMaxBitrate,
        codec: this.streamCodec(),
      }),
      headers: client.authHeaders(),
      // A fully downloaded original always wins over streaming.
      localPath: this.deps.downloads.pathFor(item.id),
      albumId: item.albumId,
      fallbackGainDb: item.normalizationGain,
    };
  }

  private loadIndex(i: number, startPlaying = true): Promise<void> {
    const entry = this.queue[i];
    if (!entry) return Promise.resolve();
    this.flushLong();
    this.longTrack = null;
    this.repeatEntryId = null;
    this.currentEntryId = `${entry.uid}`;
    const request = this.request(i, this.currentEntryId);
    this.pendingSeekMs = null;
    this.seekGuard = null;
    this.positionMs = 0;
    this.durationMs = itemDurationMs(entry.item);
    const resumeAt = this.savedLongPosition(entry.item);
    if (resumeAt !== null) {
      this.positionMs = resumeAt;
      this.seekGuard = { target: resumeAt, until: this.now() + SEEK_GUARD_MS };
    }
    this.signalPath = null;
    this.playback = startPlaying ? 'buffering' : 'paused';
    if (!request) {
      this.deps.errors.report('Not signed in.');
      return Promise.resolve();
    }
    this.reportStart(entry.item);
    const next = this.nextRequest();
    const ahead = this.prefetchRequests();
    this.lastPrefetchKey = prefetchKey(ahead);
    this.maybeExtendRadio();
    return this.run(async () => {
      await this.deps.engine.load(request, startPlaying);
      if (resumeAt !== null) await this.deps.engine.seek(resumeAt);
      await this.deps.engine.setNext(next);
      await this.deps.engine.prefetch(ahead);
    });
  }

  private nextRequest(): TrackRequest | null {
    const n = this.nextIndex;
    return n === null ? null : this.request(n, this.entryId(n));
  }

  /** Makes the engine's queued next track match the queue. */
  private armNext(): Promise<void> {
    // Built now, from the queue as it is now, not when the call runs.
    const request = this.nextRequest();
    const done = this.run(() => this.deps.engine.setNext(request));
    void this.syncPrefetch();
    this.maybeExtendRadio();
    return done;
  }

  /**
   * The `prefetchTracks` queue tracks after the armed next one, in the order
   * they will play. Downloaded tracks are skipped (they are local files).
   */
  private prefetchRequests(): TrackRequest[] {
    const count = this.deps.settings.current.streaming.prefetchTracks;
    const n = this.nextIndex;
    if (count <= 0 || n === null || n === this.index || this.index < 0) return [];
    const out: TrackRequest[] = [];
    const seen = new Set<string>();
    const len = this.queue.length;
    for (let step = 1; step <= count; step++) {
      let i: number = n + step;
      if (i >= len) {
        if (this.repeat !== 'all') break;
        i -= len;
      }
      if (i === this.index || i === n) break;
      const req = this.request(i, this.entryId(i));
      if (!req || req.localPath !== null || seen.has(req.id)) continue;
      seen.add(req.id);
      out.push(req);
    }
    return out;
  }

  /** Tells the engine what to download ahead; an identical list is not resent. */
  private syncPrefetch(empty = false): Promise<void> {
    const list = empty || this.current === null ? [] : this.prefetchRequests();
    const key = prefetchKey(list);
    if (key === this.lastPrefetchKey) return Promise.resolve();
    this.lastPrefetchKey = key;
    return this.run(() => this.deps.engine.prefetch(list));
  }

  private shuffled(list: readonly QueueEntry[], skip: number): QueueEntry[] {
    const rest = list.filter((_, i) => i !== skip);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const a = rest[i] as QueueEntry;
      rest[i] = rest[j] as QueueEntry;
      rest[j] = a;
    }
    return rest;
  }

  // ----------------------------------------------------------------- events

  private handleEvent(e: EngineEvent): void {
    switch (e.kind) {
      case 'stateChanged': {
        const was = this.playback;
        if (e.state === was) break;
        this.playback = e.state;
        if (e.state === 'paused') this.flushLong();
        if (
          this.current &&
          (e.state === 'paused' || (e.state === 'playing' && was === 'paused'))
        ) {
          this.reportProgress();
        }
        break;
      }
      case 'position': {
        if (e.entryId !== null && e.entryId !== this.currentEntryId) return;
        const g = this.seekGuard;
        if (g) {
          // After a seek, ignore stale positions until the engine is near the target.
          if (Math.abs(e.positionMs - g.target) <= SEEK_NEAR_MS || this.now() >= g.until) {
            this.seekGuard = null;
          } else break;
        }
        this.positionMs = e.positionMs;
        if (e.durationMs > 0 && e.durationMs !== this.durationMs) this.durationMs = e.durationMs;
        this.trackLong(false);
        if (this.isPlaying && this.now() - this.lastProgress >= PROGRESS_INTERVAL_MS) {
          this.reportProgress();
        }
        break;
      }
      case 'trackStarted':
        this.onTrackStarted(e);
        break;
      case 'trackEnded':
        if (e.entryId === this.currentEntryId) this.forgetLong();
        if (this.nextIndex === null && e.entryId === this.currentEntryId) {
          this.reportStopped();
          this.playback = 'stopped';
          this.positionMs = 0;
          void this.syncPrefetch(true);
          void this.run(() => this.deps.engine.stop());
        }
        break;
      case 'throughput': {
        const before = this.effectiveMaxBitrate;
        this.throughputBps = ewma(this.throughputBps, e.throughputBps);
        if (this.current !== null && this.effectiveMaxBitrate !== before) void this.armNext();
        // Network stats from the downloader, not playback: its `state` is not the
        // player's, so listeners (scrobbling, Discord) must not see it.
        return;
      }
      case 'fetchProgress':
        // Cache progress of one download, not playback (see 'throughput').
        return;
      case 'signalPathChanged':
        this.signalPath = e.signalPath;
        break;
      case 'error':
        this.deps.errors.report(e.message ?? 'Playback error.');
        break;
    }
    this.forward(e);
  }

  private onTrackStarted(e: EngineEvent): void {
    const entryId = e.entryId;
    if (entryId === null || entryId === this.currentEntryId) return;
    const target = this.indexOfEntry(entryId);
    const entry = this.queue[target];
    if (target < 0 || !entry) return;
    this.reportStopped();
    this.flushLong();
    this.longTrack = null;
    this.currentEntryId = entryId;
    if (entryId === this.repeatEntryId) this.repeatEntryId = null;
    this.index = target;
    this.seekGuard = null;
    this.durationMs = itemDurationMs(entry.item);
    this.positionMs = 0;
    this.reportStart(entry.item);
    void this.armNext();
    // A long track with a remembered position (e.g. a gapless advance into it) continues there.
    const at = this.savedLongPosition(entry.item);
    if (at !== null) void this.seek(at);
  }

  // ------------------------------------------------- long-track resume

  private longThresholdMs(): number {
    return this.deps.settings.current.playback.resumeLongTracksMin * 60_000;
  }

  private isLong(durationMs: number): boolean {
    const min = this.longThresholdMs();
    return this.deps.longResume !== undefined && min > 0 && durationMs >= min;
  }

  /** The remembered position of `item` when it is a long track worth resuming, else null. */
  private savedLongPosition(item: BaseItem): number | null {
    const dur = itemDurationMs(item);
    if (!this.isLong(dur)) return null;
    const at = this.deps.longResume?.get(item.id) ?? null;
    return at !== null && at >= 1000 && at < dur - LONG_RESUME_DONE_MS ? at : null;
  }

  private saveLong(id: string, durationMs: number, positionMs: number): void {
    this.lastLongSave = this.now();
    const done = positionMs < 1000 || positionMs >= durationMs - LONG_RESUME_DONE_MS;
    this.deps.longResume?.set(id, done ? null : Math.floor(positionMs));
  }

  /** Called with each position event: remembers the track and saves (throttled). */
  private trackLong(force: boolean): void {
    const item = this.current;
    if (!item || !this.isLong(this.durationMs)) {
      this.longTrack = null;
      return;
    }
    this.longTrack = { id: item.id, durationMs: this.durationMs };
    if (force || this.now() - this.lastLongSave >= LONG_RESUME_THROTTLE_MS) {
      this.saveLong(item.id, this.durationMs, this.positionMs);
    }
  }

  /** Saves the position of the track being left / paused. */
  private flushLong(): void {
    const t = this.longTrack;
    if (t) this.saveLong(t.id, t.durationMs, this.positionMs);
  }

  private forgetLong(): void {
    const t = this.longTrack;
    if (t) this.deps.longResume?.set(t.id, null);
    this.longTrack = null;
  }

  private forward(e: EngineEvent): void {
    if (this.listeners.size === 0) return;
    const i = e.entryId === null ? this.index : this.indexOfEntry(e.entryId);
    const entry = this.queue[i] ?? null;
    const event: PlayerEvent = {
      kind: e.kind,
      state: e.state,
      entryId: e.entryId,
      entry,
      item: entry?.item ?? null,
      meta: entry ? toTrackMeta(entry.item) : null,
      positionMs: e.positionMs,
      durationMs: e.durationMs,
      signalPath: e.signalPath,
      message: e.message,
    };
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        // a faulty integration must not disturb playback
      }
    }
  }

  // ----------------------------------------------- Jellyfin reporting (best effort)

  private transcodingFor(item: BaseItem): boolean {
    if (this.deps.downloads.isDownloaded(item.id)) return false;
    return willTranscode(item, this.effectiveMaxBitrate);
  }

  /** Fields remote controllers show: volume, repeat/shuffle, queue. */
  private reportExtras(): PlaybackExtra {
    const item = this.current;
    const volume = this.deps.settings.current.dsp.volume;
    const sourceId = item?.mediaSources[0]?.id ?? item?.id;
    return {
      ...(sourceId !== undefined ? { MediaSourceId: sourceId } : {}),
      VolumeLevel: clamp(Math.round(volume * 100), 0, 100),
      IsMuted: volume <= 0,
      RepeatMode: { off: 'RepeatNone', all: 'RepeatAll', one: 'RepeatOne' }[this.repeat],
      PlaybackOrder: this.shuffle ? 'Shuffle' : 'Default',
      NowPlayingQueue: this.queue.map((e) => ({ Id: e.item.id, PlaylistItemId: `${e.uid}` })),
    };
  }

  private fire(call: (c: JellyfinClient) => Promise<void>): void {
    const client = this.deps.client();
    if (!client) return;
    // Reporting is best effort; never disturb playback.
    call(client).catch(() => {});
  }

  private reportStart(item: BaseItem): void {
    this.reportedId = item.id;
    this.reportedTranscoding = this.transcodingFor(item);
    this.lastProgress = this.now();
    const transcoding = this.reportedTranscoding;
    const extra = this.reportExtras();
    this.fire((c) => c.reportPlaybackStart(item.id, { transcoding, extra }));
  }

  private reportProgress(): void {
    const id = this.reportedId;
    if (id === null) return;
    this.lastProgress = this.now();
    const pos = this.positionMs;
    const paused = this.playback === 'paused';
    const transcoding = this.reportedTranscoding;
    const extra = this.reportExtras();
    this.fire((c) => c.reportPlaybackProgress(id, pos, { paused, transcoding, extra }));
  }

  private reportStopped(): void {
    const id = this.reportedId;
    if (id === null) return;
    this.reportedId = null;
    const pos = this.positionMs;
    const transcoding = this.reportedTranscoding;
    this.fire((c) => c.reportPlaybackStopped(id, pos, { transcoding }));
  }
}

function prefetchKey(list: readonly TrackRequest[]): string {
  return list.map((r) => `${r.entryId}|${r.url}`).join('\n');
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
