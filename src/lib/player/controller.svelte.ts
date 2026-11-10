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
import type { AppSettings } from '../settings/types';
import type { TrackMeta } from '../track-meta';
import type { EngineErrors } from './errors.svelte';

export type RepeatMode = 'off' | 'all' | 'one';
const REPEAT_ORDER: readonly RepeatMode[] = ['off', 'all', 'one'];

/** A queue slot. `uid` keeps duplicates of the same track distinct. */
export interface QueueEntry {
  readonly uid: number;
  readonly item: BaseItem;
}

export type PlayerEngine = Pick<
  Ipc,
  'load' | 'setNext' | 'play' | 'pause' | 'stop' | 'seek' | 'onEngineEvent'
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
  /** Index that plays after the current track ends on its own. */
  nextIndex = $derived.by<number | null>(() => {
    if (this.index < 0 || this.queue.length === 0) return null;
    if (this.repeat === 'one') return this.index;
    if (this.index + 1 < this.queue.length) return this.index + 1;
    return this.repeat === 'all' ? 0 : null;
  });

  private readonly deps: PlayerDeps;
  private readonly random: () => number;
  private readonly now: () => number;
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

  // Jellyfin reporting.
  private reportedId: string | null = null;
  private reportedTranscoding = false;
  private lastProgress = 0;

  constructor(deps: PlayerDeps) {
    this.deps = deps;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.lastProgress = this.now();
    // A new bitrate cap changes the URL of the upcoming track.
    this.unsubSettings = deps.settings.onChange((s, prev) => {
      if (s.maxBitrate !== prev.maxBitrate && this.current !== null) void this.armNext();
    });
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
    return this.run(() => this.deps.engine.play());
  }

  pause(): Promise<void> {
    return this.run(() => this.deps.engine.pause());
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
    if (this.pendingSeekMs !== null) {
      // Restored but not loaded yet: remember where the first play() starts.
      this.pendingSeekMs = positionMs;
      return Promise.resolve();
    }
    this.reportProgress();
    return this.run(() => this.deps.engine.seek(positionMs));
  }

  stop(): Promise<void> {
    this.reportStopped();
    this.playback = 'stopped';
    this.positionMs = 0;
    return this.run(() => this.deps.engine.stop());
  }

  /** Stops playback and empties the queue (used when switching profiles). */
  clear(): Promise<void> {
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
  private run(call: () => Promise<unknown>): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await call();
      } catch (e) {
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
      url: client.streamUrl(item.id, { maxBitrate: this.deps.settings.current.maxBitrate }),
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
    this.repeatEntryId = null;
    this.currentEntryId = `${entry.uid}`;
    const request = this.request(i, this.currentEntryId);
    this.pendingSeekMs = null;
    this.positionMs = 0;
    this.durationMs = itemDurationMs(entry.item);
    this.signalPath = null;
    this.playback = startPlaying ? 'buffering' : 'paused';
    if (!request) {
      this.deps.errors.report('Not signed in.');
      return Promise.resolve();
    }
    this.reportStart(entry.item);
    return this.run(async () => {
      await this.deps.engine.load(request, startPlaying);
      await this.deps.engine.setNext(this.nextRequest());
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
    return this.run(() => this.deps.engine.setNext(request));
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
        this.positionMs = e.positionMs;
        if (e.durationMs > 0 && e.durationMs !== this.durationMs) this.durationMs = e.durationMs;
        if (this.isPlaying && this.now() - this.lastProgress >= PROGRESS_INTERVAL_MS) {
          this.reportProgress();
        }
        break;
      }
      case 'trackStarted':
        this.onTrackStarted(e);
        break;
      case 'trackEnded':
        if (this.nextIndex === null && e.entryId === this.currentEntryId) {
          this.reportStopped();
          this.playback = 'stopped';
          this.positionMs = 0;
          void this.run(() => this.deps.engine.stop());
        }
        break;
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
    this.currentEntryId = entryId;
    if (entryId === this.repeatEntryId) this.repeatEntryId = null;
    this.index = target;
    this.durationMs = itemDurationMs(entry.item);
    this.positionMs = 0;
    this.reportStart(entry.item);
    void this.armNext();
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
    return willTranscode(item, this.deps.settings.current.maxBitrate);
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
