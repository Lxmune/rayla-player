import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { flush, track } from '../../lib/test-support';
import { buildApp, signedIn, withContext } from '../testing';
import NowPlaying from './NowPlaying.svelte';
import QueuePanel from './QueuePanel.svelte';
import SleepTimerButton from './SleepTimerButton.svelte';

afterEach(cleanup);

const ids = (app: Awaited<ReturnType<typeof signedIn>>['app']) =>
  app.core.player.queue.map((e) => e.item.id);

describe('QueuePanel', () => {
  it('shows the empty state', () => {
    const { app } = buildApp();
    render(QueuePanel, { context: withContext(app).context });
    expect(screen.getByText('The queue is empty.')).toBeTruthy();
  });

  it('lists sections, reorders by button and by Alt+Arrow, removes, clears upcoming', async () => {
    const { app } = await signedIn();
    await app.core.player.playQueue([track('a'), track('b'), track('c'), track('d')]);
    render(QueuePanel, { context: withContext(app).context });
    expect(screen.getByRole('list', { name: 'Queue' })).toBeTruthy();
    expect(screen.getByText('Now playing')).toBeTruthy();
    expect(screen.getByText('Up next')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);

    await fireEvent.click(screen.getByRole('button', { name: 'Move Track c up' }));
    expect(ids(app)).toEqual(['a', 'c', 'b', 'd']);

    await fireEvent.keyDown(screen.getByRole('button', { name: 'Play Track d' }), { key: 'ArrowUp', altKey: true });
    expect(ids(app)).toEqual(['a', 'c', 'd', 'b']);

    await fireEvent.click(screen.getByRole('button', { name: 'Remove Track c from queue' }));
    expect(ids(app)).toEqual(['a', 'd', 'b']);

    await fireEvent.click(screen.getByRole('button', { name: 'Clear upcoming' }));
    expect(ids(app)).toEqual(['a']);
  });

  it('keeps earlier tracks in a collapsed history', async () => {
    const { app } = await signedIn();
    await app.core.player.playQueue([track('a'), track('b'), track('c')], { startIndex: 2 });
    render(QueuePanel, { context: withContext(app).context });
    expect(screen.queryByRole('button', { name: 'Play Track a' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: /History \(2\)/ }));
    expect(screen.getByRole('button', { name: 'Play Track a' })).toBeTruthy();
  });

  it('saves the queue as a playlist', async () => {
    const { app, http } = await signedIn({ 'POST /Playlists': { Id: 'pl1' } });
    await app.core.player.playQueue([track('a'), track('b')]);
    render(QueuePanel, { context: withContext(app).context });
    await fireEvent.click(screen.getByRole('button', { name: 'Save as playlist' }));
    await fireEvent.input(screen.getByLabelText('Playlist name'), { target: { value: 'Road trip' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(http.paths).toContain('/Playlists'));
  });
});

describe('SleepTimerButton', () => {
  it('opens a menu whose entries start the timer', async () => {
    const { app } = await signedIn();
    await app.core.player.playQueue([track('a')]);
    const ctx = withContext(app);
    render(SleepTimerButton, { context: ctx.context });
    await fireEvent.click(screen.getByRole('button', { name: 'Sleep timer' }));
    const entries = ctx.ui.menu?.entries ?? [];
    expect(entries.filter((e) => e !== 'separator').map((e) => (e as { label: string }).label)).toEqual([
      '15 minutes', '30 minutes', '45 minutes', '60 minutes', '90 minutes', 'End of track', 'Cancel timer',
    ]);
    (entries[1] as { onselect: () => void }).onselect();
    await flush();
    expect(app.core.sleep.mode).toBe('timer');
    expect(app.core.sleep.remainingMs).toBe(30 * 60_000);
    app.core.sleep.cancel();
  });
});

describe('NowPlaying', () => {
  it('switches tabs through ui state', async () => {
    const { app } = await signedIn();
    await app.core.player.playQueue([track('a'), track('b')]);
    const ctx = withContext(app);
    render(NowPlaying, { context: ctx.context });
    expect(screen.getByRole('tab', { name: 'Lyrics' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Up next')).toBeTruthy();
    await fireEvent.click(screen.getByRole('tab', { name: 'Queue' }));
    expect(ctx.ui.nowPlayingTab).toBe('queue');
    expect(screen.getByRole('list', { name: 'Queue' })).toBeTruthy();
  });
});

describe('NowPlaying cover swipe', () => {
  it('a horizontal trackpad swipe over the cover skips once', async () => {
    const { app } = await signedIn();
    await app.core.player.playQueue([track('a'), track('b'), track('c')]);
    const { container } = render(NowPlaying, { context: withContext(app).context });
    const cover = container.querySelector('.cover') as HTMLElement;
    expect(cover).toBeTruthy();
    for (let i = 0; i < 5; i++) await fireEvent.wheel(cover, { deltaX: 40, deltaY: 0 });
    await waitFor(() => expect(app.core.player.current?.id).toBe('b'));
    await flush();
    expect(app.core.player.current?.id).toBe('b');
  });
});

describe('SeekBar', () => {
  it('toggles elapsed/remaining on the end time and remembers it', async () => {
    const { default: SeekBar } = await import('../common/SeekBar.svelte');
    const { app } = await signedIn();
    await app.core.player.playQueue([track('a')]);
    render(SeekBar, { context: withContext(app).context });
    const end = screen.getByRole('button', { name: '3:00' });
    await fireEvent.click(end);
    expect(screen.getByRole('button', { name: '-3:00' })).toBeTruthy();
    expect(localStorage.getItem('rayla.showRemaining')).toBe('1');
    await fireEvent.click(screen.getByRole('button', { name: '-3:00' }));
    expect(localStorage.getItem('rayla.showRemaining')).toBe('0');
  });
});
