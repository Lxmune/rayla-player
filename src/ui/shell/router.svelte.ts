// State-based router with back history; no library. A route is a plain object.

import { getContext, setContext } from 'svelte';
import type { BaseItem } from '../../lib/jellyfin/models';

export type RootRoute = 'home' | 'artists' | 'albums' | 'playlists' | 'search' | 'downloads' | 'settings';

export type Route =
  | { name: RootRoute }
  | { name: 'artist'; item: BaseItem }
  | { name: 'album'; item: BaseItem }
  | { name: 'playlist'; item: BaseItem };

export class Router {
  /** History, oldest first; never empty. Replaced, never mutated. */
  stack = $state.raw<Route[]>([{ name: 'home' }]);
  current = $derived<Route>(this.stack[this.stack.length - 1] ?? { name: 'home' });
  canBack = $derived(this.stack.length > 1);
  /** The sidebar section the current route belongs to. */
  section = $derived<RootRoute>(
    ((): RootRoute => {
      for (let i = this.stack.length - 1; i >= 0; i--) {
        const r = this.stack[i];
        if (r && (r.name === 'artist' || r.name === 'album' || r.name === 'playlist')) {
          return r.name === 'artist' ? 'artists' : r.name === 'album' ? 'albums' : 'playlists';
        }
        if (r) return r.name as RootRoute;
      }
      return 'home';
    })(),
  );

  /** Opens a detail route on top of the current one. */
  push(route: Route): void {
    this.stack = [...this.stack, route];
  }

  /** Switches to a top-level section, clearing the history. */
  go(root: RootRoute): void {
    this.stack = [{ name: root }];
  }

  back(): void {
    if (this.stack.length > 1) this.stack = this.stack.slice(0, -1);
  }

  /** Opens the screen that matches an item (artist, album, playlist); tracks open their album. */
  open(item: BaseItem): void {
    switch (item.type) {
      case 'MusicArtist':
        this.push({ name: 'artist', item });
        break;
      case 'MusicAlbum':
        this.push({ name: 'album', item });
        break;
      case 'Playlist':
        this.push({ name: 'playlist', item });
        break;
      default:
        break;
    }
  }
}

export const ROUTER_KEY = Symbol('rayla-router');
export const provideRouter = (r: Router): Router => setContext(ROUTER_KEY, r);
export const getRouter = (): Router => getContext<Router>(ROUTER_KEY);

/** Which sheet is open on top of the shell. */
export type SheetKind =
  | { kind: 'signal' }
  | { kind: 'tech'; item: BaseItem }
  | { kind: 'accounts' };

/** Transient UI state shared by the shell, player bar and now-playing view. */
export class UiState {
  nowPlayingOpen = $state(false);
  sheet = $state.raw<SheetKind | null>(null);
}

export const UI_KEY = Symbol('rayla-ui');
export const provideUi = (u: UiState): UiState => setContext(UI_KEY, u);
export const getUi = (): UiState => getContext<UiState>(UI_KEY);
