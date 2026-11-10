// "Keep offline": albums and playlists whose tracks are kept downloaded. Persisted per
// profile in kv; a sync pass (planSync) downloads missing tracks and drops stale ones.

import type { NetworkType } from '../android';
import type { JellyfinClient } from '../jellyfin/client';
import { baseItemToJson, parseBaseItem, type BaseItem } from '../jellyfin/models';
import type { KeyValueStore } from '../platform';
import type { DownloadsStore } from './store.svelte';
import { collectionProgress, planSync, type Managed } from './sync-plan';

export const keptKey = (profileId: string) => `downloads.kept.${profileId}`;
export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface KeptCollection {
  item: BaseItem;
  /** Track ids as of the last successful sync. */
  trackIds: string[];
}

export interface KeptDeps {
  downloads: DownloadsStore;
  client: () => JellyfinClient | null;
  kv: KeyValueStore;
  profileId: () => string | null;
  network?: {
    onChange(cb: (type: NetworkType) => void): Promise<() => void> | (() => void);
  };
  /** Test hook for the periodic timer. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class KeptStore {
  collections = $state.raw<readonly KeptCollection[]>([]);
  syncing = $state(false);

  private managed: Managed = {};
  private loadedFor: string | null = null;
  private unlistenNetwork: (() => void) | null = null;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: KeptDeps) {}

  isKept(id: string): boolean {
    return this.collections.some((c) => c.item.id === id);
  }

  /** n of m tracks downloaded for a kept collection. */
  progress(id: string): { have: number; total: number } {
    const c = this.collections.find((x) => x.item.id === id);
    if (!c) return { have: 0, total: 0 };
    const done = new Set<string>(this.deps.downloads.entries.keys());
    return collectionProgress(c.trackIds, done);
  }

  /** Reads the profile's kept collections (again when the profile changed). Never call from a derived. */
  ensureLoaded(): void {
    const profile = this.deps.profileId();
    if (profile === this.loadedFor) return;
    this.loadedFor = profile;
    this.collections = [];
    this.managed = {};
    if (!profile) return;
    try {
      const raw = this.deps.kv.get(keptKey(profile));
      const j: unknown = raw ? JSON.parse(raw) : null;
      if (j && typeof j === 'object') {
        const o = j as { collections?: unknown; managed?: unknown };
        if (Array.isArray(o.collections)) {
          this.collections = o.collections
            .map((c: { item?: unknown; trackIds?: unknown }) => ({
              item: parseBaseItem(c?.item),
              trackIds: Array.isArray(c?.trackIds) ? c.trackIds.filter((t): t is string => typeof t === 'string') : [],
            }))
            .filter((c) => c.item.id !== '');
        }
        if (o.managed && typeof o.managed === 'object') this.managed = o.managed as Managed;
      }
    } catch {
      // corrupt: start empty
    }
  }

  private save(): void {
    const profile = this.deps.profileId();
    if (!profile) return;
    this.deps.kv.set(
      keptKey(profile),
      this.collections.length === 0 && Object.keys(this.managed).length === 0
        ? null
        : JSON.stringify({
            collections: this.collections.map((c) => ({ item: baseItemToJson(c.item), trackIds: c.trackIds })),
            managed: this.managed,
          }),
    );
  }

  /** Marks or unmarks a collection, then syncs. */
  async setKept(item: BaseItem, kept: boolean): Promise<void> {
    this.ensureLoaded();
    if (!this.deps.profileId()) return;
    const without = this.collections.filter((c) => c.item.id !== item.id);
    if (kept) {
      const existing = this.collections.find((c) => c.item.id === item.id);
      this.collections = [...without, existing ?? { item, trackIds: [] }];
    } else {
      this.collections = without;
    }
    this.save();
    await this.sync();
  }

  toggle(item: BaseItem): Promise<void> {
    return this.setKept(item, !this.isKept(item.id));
  }

  /** Runs a sync pass (one at a time; a request during a pass triggers one more). */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async pass(): Promise<void> {
    this.ensureLoaded();
    const client = this.deps.client();
    const dl = this.deps.downloads;
    if (!client || !this.deps.profileId()) return;
    this.syncing = true;
    try {
      await dl.ready;
      const loaded: { id: string; trackIds: string[] }[] = [];
      const items = new Map<string, BaseItem>();
      const next: KeptCollection[] = [];
      for (const c of this.collections) {
        try {
          const tracks = (await client.tracksOf(c.item)).filter((t) => t.type === 'Audio');
          for (const t of tracks) items.set(t.id, t);
          const ids = tracks.map((t) => t.id);
          loaded.push({ id: c.item.id, trackIds: ids });
          next.push({ item: c.item, trackIds: ids });
        } catch {
          next.push(c);
        }
      }
      // Collections were edited while loading: this pass is stale, redo it.
      if (this.collections.length !== next.length || this.collections.some((c, i) => c.item.id !== next[i]?.item.id)) {
        this.again = true;
        return;
      }
      const plan = planSync({
        kept: this.collections.map((c) => c.item.id),
        loaded,
        downloaded: new Set(dl.entries.keys()),
        queued: new Set([...dl.active.keys(), ...dl.failed.keys()]),
        managed: this.managed,
      });
      this.collections = next;
      this.managed = plan.managed;
      this.save();
      for (const id of plan.remove) {
        if (dl.active.has(id)) dl.cancel(id);
        if (dl.isDownloaded(id)) await dl.delete(id);
      }
      const wanted = plan.download.map((id) => items.get(id)).filter((t): t is BaseItem => !!t);
      if (wanted.length > 0) void dl.download(wanted);
    } finally {
      this.syncing = false;
    }
  }

  /** Subscribes to network changes and starts the periodic sync. */
  async start(): Promise<void> {
    if (this.timer === null) {
      const set = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
      this.timer = set(() => void this.sync(), SYNC_INTERVAL_MS);
    }
    if (!this.unlistenNetwork && this.deps.network) {
      try {
        this.unlistenNetwork = await this.deps.network.onChange((t) => {
          if (t === 'wifi' || t === 'ethernet' || t === 'other') void this.sync();
        });
      } catch {
        // no network events
      }
    }
    await this.sync();
  }

  dispose(): void {
    if (this.timer !== null) {
      (this.deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer);
      this.timer = null;
    }
    this.unlistenNetwork?.();
    this.unlistenNetwork = null;
  }
}
