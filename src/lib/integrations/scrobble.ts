import type { KeyValueStore } from '../platform';
import type { TrackMeta } from '../track-meta';
import { ScrobbleError, type ScrobbleTrack, type Scrobbler } from './scrobblers';

/** Scrobble payload from a track. `durationMs` (player-reported) wins when > 0. */
export function scrobbleTrackFor(meta: TrackMeta, durationMs?: number): ScrobbleTrack {
  const artist = meta.artists.length > 0 ? meta.artists.join(', ') : (meta.albumArtist ?? '');
  return {
    title: meta.title,
    artist,
    album: meta.album,
    albumArtist: meta.albumArtist,
    durationMs: durationMs !== undefined && durationMs > 0 ? durationMs : meta.durationMs > 0 ? meta.durationMs : null,
    trackNumber: meta.trackNumber,
  };
}

export interface PendingScrobble {
  service: string;
  track: ScrobbleTrack;
  /** unix epoch ms */
  listenedAtMs: number;
}

/** Failed scrobbles waiting for another attempt, persisted in the KeyValueStore. */
export class ScrobbleRetryQueue {
  static readonly key = 'scrobble.retry';
  static readonly maxEntries = 500;

  constructor(private readonly kv: KeyValueStore) {}

  load(): PendingScrobble[] {
    const raw = this.kv.get(ScrobbleRetryQueue.key);
    if (raw === null) return [];
    try {
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? (v as PendingScrobble[]) : [];
    } catch {
      return [];
    }
  }

  private save(items: PendingScrobble[]) {
    this.kv.set(ScrobbleRetryQueue.key, items.length === 0 ? null : JSON.stringify(items));
  }

  add(p: PendingScrobble) {
    const items = [...this.load(), p];
    this.save(items.length > ScrobbleRetryQueue.maxEntries ? items.slice(-ScrobbleRetryQueue.maxEntries) : items);
  }

  /** Tries every queued scrobble for the given services, oldest first. Successes and
   *  permanent failures are dropped; a retryable failure blocks that service and keeps
   *  its remainder (order kept). Entries of unknown services are kept. */
  async flush(scrobblers: Scrobbler[]): Promise<void> {
    const byId = new Map(scrobblers.map((s) => [s.id, s]));
    const blocked = new Set<string>();
    const remaining: PendingScrobble[] = [];
    for (const p of this.load()) {
      const s = byId.get(p.service);
      if (!s || blocked.has(p.service)) {
        remaining.push(p);
        continue;
      }
      try {
        await s.scrobble(p.track, p.listenedAtMs);
      } catch (e) {
        if (e instanceof ScrobbleError && !e.retryable) continue;
        blocked.add(p.service);
        remaining.push(p);
      }
    }
    this.save(remaining);
  }
}

export interface ScrobbleObservation {
  /** Queue-entry id; null = nothing loaded. */
  entryId: string | null;
  meta: TrackMeta | null;
  positionMs: number;
  /** Player-reported duration; 0/unknown falls back to the track's. */
  durationMs: number;
  playing: boolean;
}

export interface ScrobbleTrackerOptions {
  /** Currently enabled and configured services. */
  scrobblers: () => Scrobbler[];
  queue: ScrobbleRetryQueue;
  clock?: () => number;
  /** Largest forward position step (ms) that still counts as listening. */
  maxStepMs?: number;
}

/** Counts actual listening time and submits now-playing / scrobbles.
 *
 *  Feed it player state through `observe` (every position tick is fine). Time only
 *  accrues while playing and only for small forward steps, so pauses and seeks do not
 *  count. A repeat of the same queue entry is detected when the position wraps from
 *  the end of the track back to the start. */
export class ScrobbleTracker {
  static readonly minTrackLengthMs = 30_000;
  static readonly scrobbleAfterMs = 4 * 60_000;

  private readonly scrobblers: () => Scrobbler[];
  private readonly queue: ScrobbleRetryQueue;
  private readonly clock: () => number;
  private readonly maxStepMs: number;

  private entryId: string | null = null;
  private listenedMs = 0;
  private lastPositionMs = 0;
  private startedAtMs = 0;
  private scrobbled = false;
  private nowPlayingSent = false;

  constructor(o: ScrobbleTrackerOptions) {
    this.scrobblers = o.scrobblers;
    this.queue = o.queue;
    this.clock = o.clock ?? Date.now;
    this.maxStepMs = o.maxStepMs ?? 2000;
  }

  get listened(): number {
    return this.listenedMs;
  }

  async observe(o: ScrobbleObservation): Promise<void> {
    const { entryId, meta, positionMs, playing } = o;
    if (entryId === null || meta === null) {
      this.entryId = null;
      return;
    }
    const track = scrobbleTrackFor(meta, o.durationMs);
    const total = o.durationMs > 0 ? o.durationMs : (track.durationMs ?? 0);
    const wrapped =
      this.entryId === entryId &&
      total > 0 &&
      this.lastPositionMs >= total - 5000 &&
      positionMs < this.lastPositionMs &&
      this.listenedMs >= 15_000;
    if (this.entryId !== entryId || wrapped) {
      this.entryId = entryId;
      this.listenedMs = 0;
      this.scrobbled = false;
      this.nowPlayingSent = false;
      this.startedAtMs = this.clock();
    } else if (playing) {
      const step = positionMs - this.lastPositionMs;
      if (step > 0 && step <= this.maxStepMs) this.listenedMs += step;
    }
    this.lastPositionMs = positionMs;

    if (playing && !this.nowPlayingSent) {
      this.nowPlayingSent = true;
      await this.sendNowPlaying(track);
    }
    if (
      !this.scrobbled &&
      total >= ScrobbleTracker.minTrackLengthMs &&
      (this.listenedMs * 2 >= total || this.listenedMs >= ScrobbleTracker.scrobbleAfterMs)
    ) {
      this.scrobbled = true;
      await this.sendScrobble(track, this.startedAtMs);
    }
  }

  private async sendNowPlaying(track: ScrobbleTrack) {
    const active = this.scrobblers();
    await Promise.all(active.map((s) => s.nowPlaying(track).catch(() => {})));
    // Opportunistic retry while the network evidently works.
    if (this.queue.load().length > 0) await this.queue.flush(active);
  }

  private async sendScrobble(track: ScrobbleTrack, at: number) {
    for (const s of this.scrobblers()) {
      try {
        await s.scrobble(track, at);
      } catch (e) {
        if (!(e instanceof ScrobbleError) || e.retryable) {
          this.queue.add({ service: s.id, track, listenedAtMs: at });
        }
      }
    }
  }
}
