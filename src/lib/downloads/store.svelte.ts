// Offline downloads. Rust does the file I/O and keeps the index; this store
// keeps the reactive list, per-id progress and the (sequential) queue.

import type { DownloadRecord, Ipc } from '../ipc';
import type { JellyfinClient } from '../jellyfin/client';
import { baseItemToJson, firstMediaSource, formatBytes, parseBaseItem, type BaseItem } from '../jellyfin/models';
import { errorMessage, type EngineErrors } from '../player/errors.svelte';

export { formatBytes };

export type DownloadsEngine = Pick<
  Ipc,
  'downloadsList' | 'downloadsStart' | 'downloadsCancel' | 'downloadsDelete' | 'onDownloadProgress'
>;

/** A fully downloaded track. Only complete files get an entry. */
export interface DownloadEntry {
  id: string;
  item: BaseItem;
  /** Absolute path, usable as TrackRequest.localPath. */
  path: string;
  bytes: number;
  /** ISO-8601. */
  addedAt: string;
}

/** A download in flight (or waiting its turn). */
export interface DownloadProgress {
  item: BaseItem;
  receivedBytes: number;
  /** 0 when unknown. */
  totalBytes: number;
  /** False while still queued. */
  started: boolean;
}

export interface DownloadFailure {
  item: BaseItem;
  reason: string;
}

/** 0..1, or null when the total size is unknown. */
export function progressFraction(p: DownloadProgress): number | null {
  return p.totalBytes <= 0 ? null : Math.min(1, Math.max(0, p.receivedBytes / p.totalBytes));
}

/** File extension for the original file: first container name, alphanumerics only. */
export function extensionFor(item: BaseItem): string {
  const container = firstMediaSource(item)?.container?.split(',')[0]?.trim() ?? '';
  const ext = container.replace(/[^A-Za-z0-9]/g, '');
  return ext === '' ? 'bin' : ext;
}

export function entryFromRecord(rec: DownloadRecord): DownloadEntry {
  const parsed = parseBaseItem(rec.item);
  const item = parsed.id === '' ? { ...parsed, id: rec.id } : parsed;
  return { id: rec.id, item, path: rec.path, bytes: rec.bytes, addedAt: rec.addedAt };
}

export interface DownloadsDeps {
  engine: DownloadsEngine;
  /** The active Jellyfin client, or null when signed out. */
  client: () => JellyfinClient | null;
  errors?: EngineErrors;
}

export class DownloadsStore {
  /** True once the Rust-side index has been read. */
  loaded = $state(false);
  /** Completed downloads by item id (replaced, never mutated). */
  entries = $state.raw<ReadonlyMap<string, DownloadEntry>>(new Map());
  /** Queued and running downloads by item id. */
  active = $state.raw<ReadonlyMap<string, DownloadProgress>>(new Map());
  /** Item id -> what went wrong, for downloads that failed. */
  failed = $state.raw<ReadonlyMap<string, DownloadFailure>>(new Map());

  totalBytes = $derived.by(() => {
    let sum = 0;
    for (const e of this.entries.values()) sum += e.bytes;
    return sum;
  });
  /** Newest first. */
  sortedEntries = $derived(
    [...this.entries.values()].sort((a, b) => b.addedAt.localeCompare(a.addedAt)),
  );
  /** Queue order of `active`. */
  activeList = $derived([...this.active.entries()].map(([id, p]) => ({ id, ...p })));

  /** Completes once the index has been read (never rejects). */
  ready: Promise<void> = Promise.resolve();

  private readonly deps: DownloadsDeps;
  private queue: string[] = [];
  private cancelled = new Set<string>();
  private pumping = false;
  private idlePromise: Promise<void> = Promise.resolve();
  private unlisten: (() => void) | null = null;

  constructor(deps: DownloadsDeps) {
    this.deps = deps;
  }

  /** Reads the index and subscribes to progress events. Safe to call again. */
  load(): Promise<void> {
    this.ready = this.doLoad();
    return this.ready;
  }

  private async doLoad(): Promise<void> {
    const { engine } = this.deps;
    if (!this.unlisten) {
      try {
        this.unlisten = await engine.onDownloadProgress((p) => {
          const cur = this.active.get(p.id);
          if (cur) {
            this.setActive(p.id, {
              ...cur,
              started: true,
              receivedBytes: p.receivedBytes,
              totalBytes: p.totalBytes ?? 0,
            });
          }
        });
      } catch {
        // progress is cosmetic
      }
    }
    try {
      const records = await engine.downloadsList();
      this.entries = new Map(records.map((r) => [r.id, entryFromRecord(r)]));
    } catch {
      // No usable downloads directory: downloads are simply unavailable.
    }
    this.loaded = true;
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  isDownloaded(id: string): boolean {
    return this.entries.has(id);
  }

  /** Local file of a fully downloaded track, or null. */
  pathFor(id: string): string | null {
    return this.entries.get(id)?.path ?? null;
  }

  /** Completes when everything queued so far has finished or failed. */
  get idle(): Promise<void> {
    return this.idlePromise;
  }

  /** Queues `tracks` (skipping ones already downloaded or queued). Resolves when the queue drained. */
  async download(tracks: BaseItem[]): Promise<void> {
    await this.ready;
    const active = new Map(this.active);
    const failed = new Map(this.failed);
    for (const t of tracks) {
      if (t.type !== 'Audio') continue;
      if (this.entries.has(t.id) || active.has(t.id)) continue;
      active.set(t.id, { item: t, receivedBytes: 0, totalBytes: 0, started: false });
      failed.delete(t.id);
      this.cancelled.delete(t.id);
      this.queue.push(t.id);
    }
    this.active = active;
    this.failed = failed;
    if (!this.pumping) this.idlePromise = this.pump();
    return this.idlePromise;
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift() as string;
        const progress = this.active.get(id);
        if (!progress) continue; // cancelled while waiting
        await this.fetchOne(progress.item);
      }
    } finally {
      this.pumping = false;
    }
  }

  private setActive(id: string, p: DownloadProgress | null): void {
    const active = new Map(this.active);
    if (p === null) active.delete(id);
    else active.set(id, p);
    this.active = active;
  }

  private fail(item: BaseItem, reason: string): void {
    this.setActive(item.id, null);
    this.failed = new Map(this.failed).set(item.id, { item, reason });
  }

  private async fetchOne(item: BaseItem): Promise<void> {
    const client = this.deps.client();
    if (!client) {
      this.fail(item, 'Not signed in');
      return;
    }
    const cur = this.active.get(item.id);
    if (cur) this.setActive(item.id, { ...cur, started: true });
    try {
      const rec = await this.deps.engine.downloadsStart({
        id: item.id,
        url: client.downloadUrl(item.id),
        headers: client.authHeaders(),
        extension: extensionFor(item),
        item: baseItemToJson(item),
      });
      const entry = entryFromRecord(rec);
      this.entries = new Map(this.entries).set(item.id, { ...entry, item });
      this.setActive(item.id, null);
    } catch (e) {
      if (this.cancelled.delete(item.id)) {
        this.setActive(item.id, null);
      } else {
        this.fail(item, describeDownloadError(e));
      }
    }
  }

  /** Cancels a queued or running download. */
  cancel(id: string): void {
    const queuedAt = this.queue.indexOf(id);
    if (queuedAt >= 0) {
      this.queue.splice(queuedAt, 1);
      this.setActive(id, null);
      return;
    }
    const p = this.active.get(id);
    if (!p) return;
    if (p.started) {
      this.cancelled.add(id);
      this.deps.engine.downloadsCancel(id).catch(() => {});
    } else {
      this.setActive(id, null);
    }
  }

  cancelAll(): void {
    for (const id of [...this.active.keys()]) this.cancel(id);
  }

  async delete(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const entries = new Map(this.entries);
    entries.delete(id);
    this.entries = entries;
    try {
      await this.deps.engine.downloadsDelete(id);
    } catch (e) {
      // Still on disk: keep listing it.
      this.entries = new Map(this.entries).set(id, entry);
      this.deps.errors?.report(e);
    }
  }

  async deleteAll(): Promise<void> {
    for (const id of [...this.entries.keys()]) await this.delete(id);
  }
}

/** The failure text of a download, as reported by the engine. */
export function describeDownloadError(e: unknown): string {
  const msg = errorMessage(e).trim();
  return msg === '' ? 'Download failed' : msg;
}
