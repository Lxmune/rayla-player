// User actions on the player / favorites / downloads, with failures routed to
// core.errors so no click handler can produce an unhandled rejection.

import { getApp, type RaylaApp } from '../../lib/app.svelte';
import type { BaseItem } from '../../lib/jellyfin/models';

export function createActions(app: RaylaApp) {
  const { core } = app;

  /** Runs `fn`, reporting a failure; never rejects. Resolves to fn's value or undefined. */
  async function guard<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      core.errors.report(e);
      return undefined;
    }
  }

  async function tracksOf(item: BaseItem): Promise<BaseItem[]> {
    const client = core.sessions.client;
    if (!client) throw new Error('Not signed in');
    return client.tracksOf(item);
  }

  return {
    guard,
    /** Plays a container item (album, playlist, artist) or a track. */
    play: (item: BaseItem, opts: { shuffle?: boolean } = {}) =>
      guard(async () => {
        const tracks = await tracksOf(item);
        await core.player.playQueue(tracks, {
          startIndex: 0,
          shuffle: opts.shuffle ?? false,
        });
      }),
    /** Plays `tracks` starting at `startIndex`. */
    playTracks: (tracks: BaseItem[], startIndex = 0, shuffle = false) =>
      guard(() => core.player.playQueue(tracks, { startIndex, shuffle })),
    instantMix: (seed: BaseItem) =>
      guard(async () => {
        const n = await core.player.playInstantMix(seed);
        if (n === 0) core.errors.report('No instant mix available for this item.');
      }),
    playNext: (tracks: BaseItem[]) => guard(() => core.player.playNext(tracks)),
    addToQueue: (tracks: BaseItem[]) => guard(() => core.player.addToQueue(tracks)),
    toggleFavorite: (item: BaseItem) => guard(() => core.favorites.toggle(item)),
    download: (tracks: BaseItem[]) => {
      // download() resolves when the whole queue drained; do not block on it.
      void guard(() => core.downloads.download(tracks));
    },
    /** Downloads every track of a container item. */
    downloadItem: (item: BaseItem) =>
      guard(async () => {
        const tracks = await tracksOf(item);
        void guard(() => core.downloads.download(tracks));
      }),
    removeDownloads: (tracks: BaseItem[]) =>
      guard(async () => {
        for (const t of tracks) await core.downloads.delete(t.id);
      }),
    setVolume: (v: number) => guard(() => core.settings.updateDsp({ volume: v })),
  };
}

export type Actions = ReturnType<typeof createActions>;

/** Actions bound to the app in context. Call during component init. */
export const useActions = (): Actions => createActions(getApp());
