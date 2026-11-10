// Small async-loading helpers. Stale results (an older load finishing after a
// newer one started) are dropped.

import type { BaseItem, ItemsPage } from '../../lib/jellyfin/models';
import { pageHasMore } from '../../lib/jellyfin/models';
import { describeError } from '../../lib/jellyfin/client';

/** Stale-while-revalidate store shared by all Resources: bounded LRU, per session. */
export class SwrCache {
  private map = new Map<string, unknown>();
  constructor(private readonly max = 64) {}
  has(key: string): boolean {
    return this.map.has(key);
  }
  get<T>(key: string): T | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key) as T;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: string, value: unknown): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}

export const resourceCache = new SwrCache();
/** Drop every cached result (profile / server switch). */
export const clearResourceCache = (): void => resourceCache.clear();

export class Resource<T> {
  data = $state.raw<T | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  private seq = 0;

  /**
   * Runs `fn`. With a `key`, a previous result for it is shown immediately (no loading
   * state) while `fn` revalidates in the background; the key must identify the data
   * (include the profile/item ids it depends on).
   */
  async load(fn: () => Promise<T>, key?: string): Promise<void> {
    const id = ++this.seq;
    this.error = null;
    const hit = key !== undefined && resourceCache.has(key);
    if (hit) {
      this.data = resourceCache.get<T>(key as string) as T;
      this.loading = false;
    } else {
      this.loading = true;
    }
    try {
      const value = await fn();
      if (id !== this.seq) return;
      this.data = value;
      if (key !== undefined) resourceCache.set(key, value);
    } catch (e) {
      if (id !== this.seq) return;
      // A failed background refresh keeps the stale data and stays quiet.
      if (!hit) this.error = describeError(e);
    } finally {
      if (id === this.seq) this.loading = false;
    }
  }
}

/** Offset-paged list of items (artists, albums, playlists). */
export class Pager {
  items = $state.raw<BaseItem[]>([]);
  total = $state(0);
  loading = $state(false);
  error = $state<string | null>(null);
  done = $state(false);
  private busy = false;

  constructor(private readonly fetchPage: (startIndex: number) => Promise<ItemsPage>) {}

  async loadMore(): Promise<void> {
    if (this.busy || this.done) return;
    this.busy = true;
    this.loading = true;
    this.error = null;
    try {
      const page = await this.fetchPage(this.items.length);
      this.items = [...this.items, ...page.items];
      this.total = page.totalRecordCount;
      // An empty page also ends the list (guards against a server that lies about the total).
      this.done = page.items.length === 0 || !pageHasMore(page);
    } catch (e) {
      this.error = describeError(e);
    } finally {
      this.busy = false;
      this.loading = false;
    }
  }
}
