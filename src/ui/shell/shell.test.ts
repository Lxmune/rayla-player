import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_CONTEXT_KEY } from '../../lib/app.svelte';
import { parseBaseItem } from '../../lib/jellyfin/models';
import { flush, trackJson } from '../../lib/test-support';
import { signedIn } from '../testing';
import Shell from './Shell.svelte';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const items = (...ts: Record<string, unknown>[]) => ({ Items: ts, TotalRecordCount: ts.length, StartIndex: 0 });
const mount = async (routes: Record<string, unknown> = {}) => {
  const built = await signedIn({ 'GET /Items': items(), 'GET /Artists/AlbumArtists': items(), ...routes });
  render(Shell, { context: new Map([[APP_CONTEXT_KEY, built.app]]) });
  await flush();
  return built;
};

describe('Shell chrome', () => {
  it('collapses the sidebar and remembers the choice', async () => {
    await mount();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav.classList.contains('collapsed')).toBe(false);
    await fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(nav.classList.contains('collapsed')).toBe(true);
    expect(localStorage.getItem('rayla.sidebarCollapsed')).toBe('1');
    await fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(localStorage.getItem('rayla.sidebarCollapsed')).toBe('0');
  });

  it('typing in the top-bar search opens the search screen', async () => {
    await mount();
    await fireEvent.input(screen.getByPlaceholderText('Search your library'), { target: { value: 'abba' } });
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('aria-current')).toBe('page');
    expect((screen.getByPlaceholderText('Search your library') as HTMLInputElement).value).toBe('abba');
  });

  it('Back and Forward walk the history', async () => {
    await mount();
    const back = screen.getByRole('button', { name: 'Back' });
    const forward = screen.getByRole('button', { name: 'Forward' });
    expect(back.hasAttribute('disabled')).toBe(true);
    await fireEvent.input(screen.getByPlaceholderText('Search your library'), { target: { value: 'x' } });
    expect(back.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(back);
    expect(forward.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(forward);
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('aria-current')).toBe('page');
  });

  it('toggles the queue drawer from the player bar and with Q', async () => {
    const { app } = await mount();
    await app.core.player.playQueue([parseBaseItem(trackJson('t1', 'First Song'))]);
    await flush();
    expect(screen.queryByRole('complementary', { name: 'Queue' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    expect(screen.getByRole('complementary', { name: 'Queue' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Close queue' }));
    expect(screen.queryByRole('complementary', { name: 'Queue' })).toBeNull();
    await fireEvent.keyDown(document.body, { key: 'q' });
    expect(screen.getByRole('complementary', { name: 'Queue' })).toBeTruthy();
  });

  it('? opens the shortcuts sheet', async () => {
    await mount();
    await fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });

  describe('phone layout', () => {
    const stubPhone = () =>
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));

    it('has section chips instead of tabs, and no bottom bar', async () => {
      stubPhone();
      await mount();
      const chips = within(screen.getByRole('navigation', { name: 'Sections' }));
      expect(chips.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
      await fireEvent.click(chips.getByRole('button', { name: 'Playlists' }));
      expect(chips.getByRole('button', { name: 'Playlists' }).getAttribute('aria-current')).toBe('page');
      expect(chips.getByRole('button', { name: 'Home' }).hasAttribute('aria-current')).toBe(false);
      expect(document.querySelector('.tabs')).toBeNull();
    });

    it('opens settings and servers from the avatar menu', async () => {
      stubPhone();
      await mount();
      await fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
      await fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
      expect(screen.getAllByRole('heading', { name: 'Settings' }).length).toBeGreaterThan(0);
      expect(screen.queryByRole('navigation', { name: 'Sections' })?.querySelector('[aria-current]')).toBeNull();
      await fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
      await fireEvent.click(screen.getByRole('menuitem', { name: 'Servers and accounts' }));
      expect(screen.getByRole('dialog', { name: 'Servers' })).toBeTruthy();
    });

    it('search icon opens the search field in the bar', async () => {
      stubPhone();
      await mount();
      await fireEvent.click(within(document.querySelector('header.top') as HTMLElement).getByRole('button', { name: 'Search' }));
      expect(screen.getByPlaceholderText('Search your library')).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    });

    it('floats a mini player that swipes to skip and opens now playing', async () => {
      stubPhone();
      const { app } = await mount();
      await app.core.player.playQueue([
        parseBaseItem(trackJson('t1', 'First Song')),
        parseBaseItem(trackJson('t2', 'Second Song')),
      ]);
      await flush();
      const bar = screen.getByRole('contentinfo', { name: 'Player' });
      const drag = (x0: number, y0: number, x1: number, y1: number) => {
        fireEvent(bar, new PointerEvent('pointerdown', { clientX: x0, clientY: y0, bubbles: true }));
        fireEvent(bar, new PointerEvent('pointerup', { clientX: x1, clientY: y1, bubbles: true }));
      };
      drag(200, 100, 120, 105);
      await flush();
      expect(app.core.player.current?.name).toBe('Second Song');
      drag(100, 100, 100, 30);
      await flush();
      expect(screen.queryByRole('dialog', { name: /now playing/i }) ?? document.querySelector('.np, [class*=now]')).toBeTruthy();
    });
  });
});
