// User actions on the player / favorites / downloads / playlists, with failures
// routed to core.errors so no click handler can produce an unhandled rejection.
// When a UiState is available, successful queue / playlist edits show a toast.

import { getContext } from 'svelte';
import { getApp, type RaylaApp } from '../../lib/app.svelte';
import type { BaseItem } from '../../lib/jellyfin/models';
import { UI_KEY, type UiState } from '../shell/router.svelte';
import { plural } from './format';

const count = (tracks: BaseItem[]) =>
  tracks.length === 1 ? `“${tracks[0]?.name ?? ''}”` : plural(tracks.length, 'track');

export function createActions(app: RaylaApp, ui?: UiState) {
  const { core } = app;
  const toast = (message: string) => ui?.toast(message);

  /** Runs `fn`, reporting a failure; never rejects. Resolves to fn's value or undefined. */
  async function guard<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      core.errors.report(e);
      return undefined;
    }
  }

  function client() {
    const c = core.sessions.client;
    if (!c) throw new Error('Not signed in');
    return c;
  }

  const tracksOf = (item: BaseItem): Promise<BaseItem[]> => client().tracksOf(item);

  return {
    guard,
    tracksOf: (item: BaseItem) => guard(() => tracksOf(item)),
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
    playNext: (tracks: BaseItem[]) =>
      guard(async () => {
        await core.player.playNext(tracks);
        if (tracks.length > 0) toast(`${count(tracks)} will play next`);
      }),
    addToQueue: (tracks: BaseItem[]) =>
      guard(async () => {
        await core.player.addToQueue(tracks);
        if (tracks.length > 0) toast(`Added ${count(tracks)} to the queue`);
      }),
    /** Play next / add to queue for a container item (album, playlist, artist). */
    playItemNext: (item: BaseItem) =>
      guard(async () => {
        const tracks = await tracksOf(item);
        await core.player.playNext(tracks);
        toast(`“${item.name}” will play next`);
      }),
    queueItem: (item: BaseItem) =>
      guard(async () => {
        const tracks = await tracksOf(item);
        await core.player.addToQueue(tracks);
        toast(`Added “${item.name}” to the queue`);
      }),
    toggleFavorite: (item: BaseItem) =>
      guard(async () => {
        const now = await core.favorites.toggle(item);
        toast(now ? `Added “${item.name}” to favorites` : `Removed “${item.name}” from favorites`);
      }),
    download: (tracks: BaseItem[]) => {
      // download() resolves when the whole queue drained; do not block on it.
      if (tracks.length > 0) toast(`Downloading ${count(tracks)}`);
      void guard(() => core.downloads.download(tracks));
    },
    /** Downloads every track of a container item. */
    downloadItem: (item: BaseItem) =>
      guard(async () => {
        const tracks = await tracksOf(item);
        toast(`Downloading “${item.name}”`);
        void guard(() => core.downloads.download(tracks));
      }),
    removeDownloads: (tracks: BaseItem[]) =>
      guard(async () => {
        for (const t of tracks) await core.downloads.delete(t.id);
        if (tracks.length > 0) toast(`Removed ${count(tracks)} from downloads`);
      }),
    setVolume: (v: number) => guard(() => core.settings.updateDsp({ volume: v })),
    /** Creates a playlist holding `tracks`; resolves to its id. */
    createPlaylist: (name: string, tracks: BaseItem[] = []) =>
      guard(async () => {
        const id = await client().createPlaylist(name, tracks.map((t) => t.id));
        toast(`Created playlist “${name}”`);
        return id;
      }),
    addToPlaylist: (playlist: BaseItem, tracks: BaseItem[]) =>
      guard(async () => {
        await client().addToPlaylist(playlist.id, tracks.map((t) => t.id));
        toast(`Added ${count(tracks)} to “${playlist.name}”`);
      }),
    /** Removes entries (tracks carrying a playlistItemId) from a playlist. */
    removeFromPlaylist: (playlist: BaseItem, entries: BaseItem[]) =>
      guard(async () => {
        const ids = entries.map((t) => t.playlistItemId).filter((id): id is string => id !== null);
        await client().removeFromPlaylist(playlist.id, ids);
        toast(`Removed ${count(entries)} from “${playlist.name}”`);
      }),
    /** Loads the album / first artist of an item as a full item (for navigation). */
    albumOf: (item: BaseItem) =>
      guard(async () => (item.albumId ? client().item(item.albumId) : null)),
    artistOf: (item: BaseItem) =>
      guard(async () => {
        const id = item.albumArtists[0]?.id ?? item.artistItems[0]?.id ?? null;
        return id ? client().item(id) : null;
      }),
  };
}

export type Actions = ReturnType<typeof createActions>;

/** Actions bound to the app (and UI, when provided) in context. Call during component init. */
export const useActions = (): Actions =>
  createActions(getApp(), getContext<UiState | undefined>(UI_KEY));
