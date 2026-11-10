// Per-track availability: offline download, stream-cache and in-flight fetch,
// as one reactive lookup for rows and the queue.

import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { DownloadsStore } from './downloads/store.svelte';
import { progressFraction } from './downloads/store.svelte';
import type { EngineEvent, Ipc, TrackRequest } from './ipc';
import type { JellyfinClient } from './jellyfin/client';
import type { PlayerController } from './player/controller.svelte';
import type { SettingsStore } from './settings/store.svelte';

export type TrackAvailability =
  | { kind: 'downloaded' }
  | { kind: 'downloading'; fraction: number | null }
  | { kind: 'cached' }
  | { kind: 'caching'; fraction: number | null }
  | { kind: 'none' };

const NONE: TrackAvailability = { kind: 'none' };
const DOWNLOADED: TrackAvailability = { kind: 'downloaded' };
const CACHED: TrackAvailability = { kind: 'cached' };

export type TrackStatesEngine = Pick<Ipc, 'onEngineEvent' | 'cachedTracks'>;

export interface TrackStatesDeps {
  engine: TrackStatesEngine;
  downloads: DownloadsStore;
  player: PlayerController;
  settings: SettingsStore;
  client: () => JellyfinClient | null;
  /** Debounce of the queue-wide cache lookup. */
  debounceMs?: number;
}

export class TrackStates {
  /** Ids the stream cache holds completely. */
  private cachedIds = new SvelteMap<string, true>();
  /** In-flight stream-cache fetches. */
  private progress = new SvelteMap<string, { cached: number; total: number }>();

  private readonly deps: TrackStatesDeps;
  private unlisten: (() => void) | null = null;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopEffect: (() => void) | null = null;

  constructor(deps: TrackStatesDeps) {
    this.deps = deps;
    void this.subscribe();
    this.stopEffect = $effect.root(() => {
      $effect(() => {
        void [deps.player.queue, deps.player.effectiveMaxBitrate, deps.settings.current.streaming.codec];
        untrack(() => this.scheduleRefresh());
      });
    });
  }

  private async subscribe(): Promise<void> {
    try {
      const un = await this.deps.engine.onEngineEvent((e) => this.onEvent(e));
      if (this.disposed) un();
      else this.unlisten = un;
    } catch {
      // indicators are cosmetic
    }
  }

  private onEvent(e: EngineEvent): void {
    if (e.kind !== 'fetchProgress' || !e.trackId) return;
    const id = e.trackId;
    if (e.totalBytes > 0 && e.cachedBytes >= e.totalBytes) {
      this.progress.delete(id);
      this.cachedIds.set(id, true);
    } else {
      this.cachedIds.delete(id);
      this.progress.set(id, { cached: e.cachedBytes, total: e.totalBytes });
      // Total unknown (chunked transcode): completion is only visible by asking.
      if (e.totalBytes <= 0) this.scheduleRefresh();
    }
  }

  get(id: string): TrackAvailability {
    const dl = this.deps.downloads;
    if (dl.entries.has(id)) return DOWNLOADED;
    const active = dl.active.get(id);
    if (active) return { kind: 'downloading', fraction: active.started ? progressFraction(active) : 0 };
    if (this.cachedIds.has(id)) return CACHED;
    const p = this.progress.get(id);
    if (p) return { kind: 'caching', fraction: p.total > 0 ? Math.min(1, p.cached / p.total) : null };
    return NONE;
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, this.deps.debounceMs ?? 300);
  }

  /** Asks the engine which queue tracks are completely cached. */
  async refresh(): Promise<void> {
    const client = this.deps.client();
    const { player, settings } = this.deps;
    if (!client || player.queue.length === 0) return;
    const seen = new Set<string>();
    const requests: TrackRequest[] = [];
    for (const entry of player.queue) {
      const item = entry.item;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      requests.push({
        id: item.id,
        entryId: `${entry.uid}`,
        url: client.streamUrl(item.id, {
          maxBitrate: player.effectiveMaxBitrate,
          codec: settings.current.streaming.codec,
        }),
        headers: client.authHeaders(),
        localPath: null,
        albumId: item.albumId,
        fallbackGainDb: item.normalizationGain,
      });
    }
    let done: string[];
    try {
      done = await this.deps.engine.cachedTracks(requests);
    } catch {
      return;
    }
    if (this.disposed) return;
    const complete = new Set(done);
    for (const id of seen) {
      if (complete.has(id)) {
        this.cachedIds.set(id, true);
        this.progress.delete(id);
      } else {
        this.cachedIds.delete(id);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.unlisten?.();
    this.unlisten = null;
    this.stopEffect?.();
    this.stopEffect = null;
  }
}

/** Accessible label for an availability, or null when there is nothing to say. */
export function availabilityLabel(a: TrackAvailability): string | null {
  const pct = (f: number | null) => (f === null ? '' : ` ${Math.round(f * 100)} %`);
  switch (a.kind) {
    case 'downloaded':
      return 'Downloaded';
    case 'downloading':
      return `Downloading${pct(a.fraction)}`;
    case 'cached':
      return 'Cached for playback';
    case 'caching':
      return `Buffering${pct(a.fraction)}`;
    default:
      return null;
  }
}
