// Small async-loading helpers. Stale results (an older load finishing after a
// newer one started) are dropped.

import type { BaseItem, ItemsPage } from '../../lib/jellyfin/models';
import { pageHasMore } from '../../lib/jellyfin/models';
import { describeError } from '../../lib/jellyfin/client';

export class Resource<T> {
  data = $state.raw<T | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  private seq = 0;

  async load(fn: () => Promise<T>): Promise<void> {
    const id = ++this.seq;
    this.loading = true;
    this.error = null;
    try {
      const value = await fn();
      if (id !== this.seq) return;
      this.data = value;
    } catch (e) {
      if (id !== this.seq) return;
      this.error = describeError(e);
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
