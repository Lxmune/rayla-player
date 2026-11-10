import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_CONTEXT_KEY } from '../../lib/app.svelte';
import { parseBaseItem } from '../../lib/jellyfin/models';
import { flush, trackJson } from '../../lib/test-support';
import { signedIn } from '../testing';
import Shell from './Shell.svelte';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

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
});
