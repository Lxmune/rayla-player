// Pure planning for "Keep offline": which tracks of kept collections to download and which
// earlier sync-made downloads to remove. Tracks are reference-counted by collection.

/** Track id -> ids of the kept collections that caused the sync to download it. */
export type Managed = Record<string, string[]>;

export interface LoadedCollection {
  id: string;
  /** Current track ids of the collection. */
  trackIds: string[];
}

export interface SyncInput {
  /** Ids of every collection that is currently kept. */
  kept: readonly string[];
  /** Kept collections whose track list could be loaded this pass. */
  loaded: readonly LoadedCollection[];
  /** Ids of completed downloads. */
  downloaded: ReadonlySet<string>;
  /** Ids queued or running (not yet complete). */
  queued: ReadonlySet<string>;
  managed: Managed;
}

export interface SyncPlan {
  /** Track ids to download (in collection order, no duplicates). */
  download: string[];
  /** Managed track ids nothing needs any more. */
  remove: string[];
  /** The new reference map. */
  managed: Managed;
}

export function planSync(input: SyncInput): SyncPlan {
  const keptSet = new Set(input.kept);
  const refs = new Map<string, Set<string>>();
  // Start from what is known, forgetting collections that are no longer kept.
  for (const [track, cols] of Object.entries(input.managed)) {
    const live = cols.filter((c) => keptSet.has(c));
    if (live.length > 0) refs.set(track, new Set(live));
  }
  const wasManaged = new Set(Object.keys(input.managed));
  const download: string[] = [];
  const queuedNow = new Set<string>();

  for (const col of input.loaded) {
    const members = new Set(col.trackIds);
    // The collection left these tracks.
    for (const [track, cols] of refs) if (cols.has(col.id) && !members.has(track)) cols.delete(col.id);
    for (const track of col.trackIds) {
      const have = refs.get(track);
      if (have) {
        have.add(col.id);
        continue;
      }
      // Downloaded or queued by the user: theirs, never claimed.
      if (input.downloaded.has(track) || (input.queued.has(track) && !wasManaged.has(track))) continue;
      refs.set(track, new Set([col.id]));
      if (!queuedNow.has(track)) {
        queuedNow.add(track);
        if (!input.queued.has(track)) download.push(track);
      }
    }
  }

  const managed: Managed = {};
  const remove: string[] = [];
  for (const [track, cols] of refs) {
    if (cols.size > 0) managed[track] = [...cols];
  }
  // Tracks that lost their last reference (and that we had claimed before).
  for (const track of wasManaged) {
    if (!managed[track]) remove.push(track);
  }
  // A collection that failed to load keeps its refs untouched: only loaded ones are pruned above.
  return { download, remove, managed };
}

/** n of m tracks of a collection that are downloaded. */
export function collectionProgress(trackIds: readonly string[], downloaded: ReadonlySet<string>): { have: number; total: number } {
  let have = 0;
  for (const id of trackIds) if (downloaded.has(id)) have++;
  return { have, total: trackIds.length };
}
