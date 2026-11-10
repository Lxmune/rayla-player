import { describe, expect, it, vi } from 'vitest';
import { parseBaseItem } from '../../lib/jellyfin/models';
import { Router, TOAST_MS, UiState } from './router.svelte';

const album = parseBaseItem({ Id: 'al1', Name: 'Album', Type: 'MusicAlbum' });
const artist = parseBaseItem({ Id: 'ar1', Name: 'Artist', Type: 'MusicArtist' });

describe('Router', () => {
  it('starts on home without back', () => {
    const r = new Router();
    expect(r.current.name).toBe('home');
    expect(r.canBack).toBe(false);
  });

  it('opens detail routes and goes back through the history', () => {
    const r = new Router();
    r.go('artists');
    r.open(artist);
    r.open(album);
    expect(r.current.name).toBe('album');
    expect(r.section).toBe('artists');
    r.back();
    expect(r.current).toEqual({ name: 'artist', item: artist });
    expect(r.section).toBe('artists');
    r.back();
    expect(r.current.name).toBe('artists');
    expect(r.canBack).toBe(false);
    r.back();
    expect(r.current.name).toBe('artists');
  });

  it('go() clears the history', () => {
    const r = new Router();
    r.open(album);
    r.go('settings');
    expect(r.stack).toHaveLength(1);
    expect(r.section).toBe('settings');
  });

  it('forward re-opens what back left and is cleared by new navigation', () => {
    const r = new Router('albums');
    expect(r.section).toBe('albums');
    r.open(album);
    r.back();
    expect(r.canForward).toBe(true);
    r.forward();
    expect(r.current).toEqual({ name: 'album', item: album });
    r.back();
    r.open(artist);
    expect(r.canForward).toBe(false);
    r.open(parseBaseItem({ Id: 'g', Name: 'Jazz', Type: 'MusicGenre' }));
    expect(r.current.name).toBe('genre');
  });

  it('ignores items without a screen', () => {
    const r = new Router();
    r.open(parseBaseItem({ Id: 't', Name: 'T', Type: 'Audio' }));
    expect(r.stack).toHaveLength(1);
  });
});

describe('Router discover', () => {
  it('is a root section that Back returns from to Home', () => {
    const r = new Router('discover');
    expect(r.current.name).toBe('discover');
    expect(r.section).toBe('discover');
    expect(r.depth).toBe(1);
    r.up();
    expect(r.current.name).toBe('home');
    r.go('discover');
    r.open({ id: 'a', name: 'A', type: 'MusicArtist' } as never);
    expect(r.section).toBe('discover');
  });
});

describe('Router.lastNav', () => {
  it('tracks the kind of navigation', () => {
    const r = new Router('home');
    expect(r.lastNav).toBe('root');
    r.push({ name: 'album', item: { id: 'a', name: 'A', type: 'MusicAlbum' } as never });
    expect(r.lastNav).toBe('push');
    r.back();
    expect(r.lastNav).toBe('back');
    r.forward();
    expect(r.lastNav).toBe('forward');
    r.go('songs');
    expect(r.lastNav).toBe('root');
  });
});

describe('UiState', () => {
  it('toasts keep the last three and auto-dismiss', () => {
    vi.useFakeTimers();
    try {
      const ui = new UiState();
      for (const m of ['a', 'b', 'c', 'd']) ui.toast(m);
      expect(ui.toasts.map((t) => t.message)).toEqual(['b', 'c', 'd']);
      vi.advanceTimersByTime(TOAST_MS);
      expect(ui.toasts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a menu at coordinates and closes it', () => {
    const ui = new UiState();
    ui.openMenu({ x: 10, y: 20 }, ['separator']);
    expect(ui.menu).toEqual({ x: 10, y: 20, entries: ['separator'] });
    ui.closeMenu();
    expect(ui.menu).toBeNull();
  });
});
