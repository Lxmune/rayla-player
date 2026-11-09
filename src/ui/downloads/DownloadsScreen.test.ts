import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { flush, track } from '../../lib/test-support';
import { buildApp } from '../settings/test-app';
import DownloadsScreen from './DownloadsScreen.svelte';

async function setup() {
  const b = buildApp();
  b.dl.manual = true;
  await b.ready();
  return b;
}

afterEach(cleanup);

describe('DownloadsScreen', () => {
  it('shows an empty state', async () => {
    const b = await setup();
    render(DownloadsScreen, { context: b.context });
    expect(screen.getByText('No downloads yet.')).toBeTruthy();
  });

  it('shows progress and cancel calls the store', async () => {
    const b = await setup();
    render(DownloadsScreen, { context: b.context });
    void b.app.core.downloads.download([track('a')]);
    await flush();
    b.dl.emitProgress({ id: 'a', receivedBytes: 512, totalBytes: 1024 });
    await flush();
    const bar = (await screen.findByRole('progressbar', { name: /Downloading Track a/ })) as HTMLProgressElement;
    expect(bar.value).toBe(0.5);
    expect(screen.getByText(/50%/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel Track a' }));
    expect(b.dl.cancelled).toEqual(['a']);
  });

  it('lists completed downloads newest first with total, plays and deletes', async () => {
    const b = await setup();
    b.dl.manual = false;
    await b.app.core.downloads.download([track('a'), track('bb')]);
    render(DownloadsScreen, { context: b.context });
    const names = screen.getAllByText(/^Track /).map((e) => e.textContent);
    expect(names).toEqual(['Track bb', 'Track a']);
    expect(screen.getByText(/2 tracks · 300 B/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Play Track a' }));
    await flush();
    expect(b.engine.calls).toContain('load(a,true)');
    await fireEvent.click(screen.getByRole('button', { name: 'Delete Track a' }));
    expect(b.dl.deleted).toEqual(['a']);
  });

  it('delete all asks for confirmation', async () => {
    const b = await setup();
    b.dl.manual = false;
    await b.app.core.downloads.download([track('a'), track('bb')]);
    render(DownloadsScreen, { context: b.context });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));
    expect(b.dl.deleted).toEqual([]);
    await fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(b.dl.deleted).toEqual([]);
    await fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(b.dl.deleted.sort()).toEqual(['a', 'bb']));
  });

  it('shows failures with the reason', async () => {
    const b = await setup();
    b.dl.manual = false;
    b.dl.failures.set('a', 'disk full');
    await b.app.core.downloads.download([track('a')]);
    render(DownloadsScreen, { context: b.context });
    expect(screen.getByText('disk full')).toBeTruthy();
  });
});
