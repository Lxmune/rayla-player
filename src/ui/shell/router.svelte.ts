// State-based router with back/forward history; no library. A route is a plain object.

import { getContext, setContext } from 'svelte';
import type { BaseItem } from '../../lib/jellyfin/models';
import type { IconName } from '../common/icons';

export type RootRoute =
  | 'home'
  | 'search'
  | 'artists'
  | 'albums'
  | 'songs'
  | 'genres'
  | 'playlists'
  | 'favorites'
  | 'downloads'
  | 'settings';

export type DetailRoute = 'artist' | 'album' | 'playlist' | 'genre';

export type Route = { name: RootRoute } | { name: DetailRoute; item: BaseItem };

const isDetail = (r: Route): r is { name: DetailRoute; item: BaseItem } => 'item' in r;

export class Router {
  /** History, oldest first; never empty. Replaced, never mutated. */
  stack = $state.raw<Route[]>([{ name: 'home' }]);
  /** Routes undone by back(), most recent last; cleared by any new navigation. */
  forwardStack = $state.raw<Route[]>([]);
  current = $derived<Route>(this.stack[this.stack.length - 1] ?? { name: 'home' });
  canBack = $derived(this.stack.length > 1);
  canForward = $derived(this.forwardStack.length > 0);
  /** The sidebar section: the root the history started from (stack[0] is always a root). */
  section = $derived<RootRoute>(((r) => (r && !isDetail(r) ? r.name : 'home'))(this.stack[0]));

  constructor(start: RootRoute = 'home') {
    this.stack = [{ name: start }];
  }

  /** Opens a detail route on top of the current one. */
  push(route: Route): void {
    this.stack = [...this.stack, route];
    this.forwardStack = [];
  }

  /** Switches to a top-level section, clearing the history. */
  go(root: RootRoute): void {
    this.stack = [{ name: root }];
    this.forwardStack = [];
  }

  back(): void {
    const top = this.stack[this.stack.length - 1];
    if (this.stack.length <= 1 || !top) return;
    this.stack = this.stack.slice(0, -1);
    this.forwardStack = [...this.forwardStack, top];
  }

  forward(): void {
    const next = this.forwardStack[this.forwardStack.length - 1];
    if (!next) return;
    this.forwardStack = this.forwardStack.slice(0, -1);
    this.stack = [...this.stack, next];
  }

  /** Opens the screen that matches an item (artist, album, playlist, genre); tracks are ignored. */
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
      case 'MusicGenre':
        this.push({ name: 'genre', item });
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
  | { kind: 'accounts' }
  | { kind: 'shortcuts' }
  | { kind: 'addToPlaylist'; tracks: BaseItem[] }
  /** Live output picker (device + exclusive), src/ui/sheets/OutputSheet.svelte. */
  | { kind: 'output' };

/** One context-menu row, or a divider. */
export type MenuEntry =
  | {
      label: string;
      icon?: IconName;
      danger?: boolean;
      disabled?: boolean;
      onselect: () => void;
    }
  | 'separator';

export interface MenuState {
  /** Viewport coordinates the menu opens at (it is clamped on screen). */
  x: number;
  y: number;
  entries: MenuEntry[];
}

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

export const TOAST_MS = 3500;

/** Transient UI state shared by the shell, player bar and now-playing view. */
export class UiState {
  nowPlayingOpen = $state(false);
  nowPlayingTab = $state<'lyrics' | 'queue'>('lyrics');
  /** Queue side panel in the shell (not the now-playing view). */
  queueOpen = $state(false);
  sheet = $state.raw<SheetKind | null>(null);
  menu = $state.raw<MenuState | null>(null);
  toasts = $state.raw<Toast[]>([]);
  /** Shared by the top-bar search field and the Search screen. */
  searchTerm = $state('');
  private nextToast = 1;

  /** Opens a context menu at the pointer (or below an element for keyboard / button use). */
  openMenu(at: MouseEvent | HTMLElement | { x: number; y: number }, entries: MenuEntry[]): void {
    let x: number;
    let y: number;
    if (typeof HTMLElement !== 'undefined' && at instanceof HTMLElement) {
      const r = at.getBoundingClientRect();
      x = r.left;
      y = r.bottom + 4;
    } else if (typeof MouseEvent !== 'undefined' && at instanceof MouseEvent) {
      at.preventDefault();
      x = at.clientX;
      y = at.clientY;
    } else {
      ({ x, y } = at as { x: number; y: number });
    }
    this.menu = { x, y, entries };
  }

  closeMenu(): void {
    this.menu = null;
  }

  /** Shows a short notice; returns its id. Dismissed after TOAST_MS. */
  toast(message: string, action?: Toast['action']): number {
    const id = this.nextToast++;
    this.toasts = [...this.toasts.slice(-2), { id, message, action }];
    setTimeout(() => this.dismissToast(id), TOAST_MS);
    return id;
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }
}

export const UI_KEY = Symbol('rayla-ui');
export const provideUi = (u: UiState): UiState => setContext(UI_KEY, u);
export const getUi = (): UiState => getContext<UiState>(UI_KEY);
