// Context-menu entries for any library item (track, album, artist, playlist,
// genre). One place decides what can be done with an item, so right-click menus
// and "more" buttons agree everywhere.

import { getContext } from 'svelte';
import { getApp } from '../../lib/app.svelte';
import { invalidateRecommendations } from '../../lib/recommend/recommender';
import type { BaseItem } from '../../lib/jellyfin/models';
import { ROUTER_KEY, UI_KEY, type MenuEntry, type Router, type UiState } from '../shell/router.svelte';
import { useActions } from './actions';

export interface ItemMenuOptions {
  /** The playlist the item is shown in: adds "Remove from playlist". */
  playlist?: BaseItem;
  /** Called after the item was removed from `playlist`. */
  onremoved?: () => void;
  /** Leave out navigation entries that point at the current screen. */
  hideAlbum?: boolean;
  hideArtist?: boolean;
}

/** Call during component init; returns a builder for an item's menu entries. */
export function useItemMenu(): (item: BaseItem, opts?: ItemMenuOptions) => MenuEntry[] {
  const app = getApp();
  const actions = useActions();
  const router = getContext<Router | undefined>(ROUTER_KEY);
  const ui = getContext<UiState | undefined>(UI_KEY);

  const close = () => {
    if (ui) {
      ui.nowPlayingOpen = false;
      ui.queueOpen = false;
    }
  };

  return (item, opts = {}) => {
    const isTrack = item.type === 'Audio';
    const favorite = app.core.favorites.isFavorite(item);
    const entries: MenuEntry[] = [];

    if (isTrack) {
      entries.push(
        { label: 'Play next', icon: 'playNext', onselect: () => void actions.playNext([item]) },
        { label: 'Add to queue', icon: 'queue', onselect: () => void actions.addToQueue([item]) },
      );
    } else {
      entries.push(
        { label: 'Play', icon: 'play', onselect: () => void actions.play(item) },
        { label: 'Shuffle', icon: 'shuffle', onselect: () => void actions.play(item, { shuffle: true }) },
        { label: 'Play next', icon: 'playNext', onselect: () => void actions.playItemNext(item) },
        { label: 'Add to queue', icon: 'queue', onselect: () => void actions.queueItem(item) },
      );
    }
    entries.push({ label: 'Instant mix', icon: 'mix', onselect: () => void actions.instantMix(item) });

    if (ui && item.type !== 'MusicGenre') {
      entries.push('separator', {
        label: 'Add to playlist…',
        icon: 'playlistAdd',
        onselect: () => {
          void (async () => {
            const tracks = isTrack ? [item] : await actions.tracksOf(item);
            if (tracks && tracks.length > 0) ui.sheet = { kind: 'addToPlaylist', tracks };
          })();
        },
      });
    }
    if (opts.playlist && isTrack && item.playlistItemId) {
      const playlist = opts.playlist;
      entries.push({
        label: 'Remove from this playlist',
        icon: 'trash',
        danger: true,
        onselect: () =>
          void actions.removeFromPlaylist(playlist, [item]).then(() => opts.onremoved?.()),
      });
    }

    if (router) {
      const nav: MenuEntry[] = [];
      if (isTrack && item.albumId && !opts.hideAlbum) {
        nav.push({
          label: 'Go to album',
          icon: 'album',
          onselect: () =>
            void actions.albumOf(item).then((a) => {
              if (a) {
                close();
                router.open(a);
              }
            }),
        });
      }
      const hasArtist = item.albumArtists.length > 0 || item.artistItems.length > 0;
      if ((isTrack || item.type === 'MusicAlbum') && hasArtist && !opts.hideArtist) {
        nav.push({
          label: 'Go to artist',
          icon: 'artist',
          onselect: () =>
            void actions.artistOf(item).then((a) => {
              if (a) {
                close();
                router.open(a);
              }
            }),
        });
      }
      if (nav.length > 0) entries.push('separator', ...nav);
    }

    entries.push('separator');
    if (item.type !== 'MusicGenre') {
      entries.push({
        label: favorite ? 'Remove from favorites' : 'Add to favorites',
        icon: favorite ? 'heartFill' : 'heart',
        onselect: () => void actions.toggleFavorite(item),
      });
    }
    if (isTrack || item.type === 'MusicAlbum' || item.type === 'MusicArtist') {
      entries.push({
        label: 'Not interested',
        icon: 'ban',
        onselect: () => {
          app.skips.dislike(item);
          const client = app.core.sessions.client;
          if (client) invalidateRecommendations(client);
          ui?.toast(`Won't recommend “${item.name}” again`, {
            label: 'Undo',
            run: () => {
              app.skips.undislike(item.id);
              if (client) invalidateRecommendations(client);
            },
          });
        },
      });
    }
    if (isTrack) {
      if (app.core.downloads.isDownloaded(item.id)) {
        entries.push({
          label: 'Remove download',
          icon: 'trash',
          onselect: () => void actions.removeDownloads([item]),
        });
      } else {
        entries.push({ label: 'Download', icon: 'download', onselect: () => actions.download([item]) });
      }
      if (ui) {
        entries.push({ label: 'Track info', icon: 'info', onselect: () => (ui.sheet = { kind: 'tech', item }) });
      }
    } else if (item.type !== 'MusicGenre') {
      entries.push({ label: 'Download all', icon: 'download', onselect: () => void actions.downloadItem(item) });
    }

    // No leading / trailing / doubled separators.
    return entries.filter(
      (e, i, all) => e !== 'separator' || (i > 0 && i < all.length - 1 && all[i - 1] !== 'separator'),
    );
  };
}
