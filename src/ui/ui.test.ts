import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App.svelte';
import { APP_CONTEXT_KEY } from '../lib/app.svelte';
import { parseBaseItem } from '../lib/jellyfin/models';
import { FakeStatus, flush, trackJson } from '../lib/test-support';
import AlbumScreen from './browse/AlbumScreen.svelte';
import Sheet from './common/Sheet.svelte';
import Lyrics from './now-playing/Lyrics.svelte';
import PlayerBar from './shell/PlayerBar.svelte';
import Shell from './shell/Shell.svelte';
import { buildApp, signedIn, withContext } from './testing';

afterEach(() => cleanup());

const album = parseBaseItem({ Id: 'al1', Name: 'Great Album', Type: 'MusicAlbum', AlbumArtist: 'Artist' });
const items = (...ts: Record<string, unknown>[]) => ({
  Items: ts,
  TotalRecordCount: ts.length,
  StartIndex: 0,
});
const tracks = () =>
  items(trackJson('t1', 'First Song', { index: 1 }), trackJson('t2', 'Second Song', { index: 2 }));

describe('App', () => {
  it('shows Login without a session and the Shell after signing in', async () => {
    const { app } = buildApp({ 'GET /Items': items() });
    render(App, { props: { app } });
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();

    await fireEvent.input(screen.getByLabelText('Server address'), { target: { value: 'https://jf.test' } });
    await fireEvent.input(screen.getByLabelText('User name'), { target: { value: 'ann' } });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(app.core.sessions.client).not.toBeNull();
  });

  it('shows a login error for bad credentials', async () => {
    const { app, http } = buildApp({});
    http.routes['POST /Users/AuthenticateByName'] = new FakeStatus(401);
    render(App, { props: { app } });
    await screen.findByRole('button', { name: 'Sign in' });
    await fireEvent.input(screen.getByLabelText('Server address'), { target: { value: 'https://jf.test' } });
    await fireEvent.input(screen.getByLabelText('User name'), { target: { value: 'ann' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Invalid username or password.');
    expect(app.core.sessions.client).toBeNull();
  });

  it('shows a dismissible engine error banner', async () => {
    const { app } = buildApp({});
    render(App, { props: { app } });
    await screen.findByRole('button', { name: 'Sign in' });
    app.core.errors.report('engine broke');
    await screen.findByText('engine broke');
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByText('engine broke')).toBeNull();
  });
});

describe('AlbumScreen', () => {
  it('lists tracks and Play starts the queue', async () => {
    const { app, engine } = await signedIn({ 'GET /Items': tracks() });
    const ctx = withContext(app);
    render(AlbumScreen, { props: { item: album }, context: ctx.context });
    await screen.findByText('First Song');
    expect(screen.getByText('Second Song')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await flush();
    expect(engine.calls).toContain('load(t1,true)');
    expect(app.core.player.queue).toHaveLength(2);
  });

  it('clicking a track starts at that track; Download queues the album', async () => {
    const { app, engine, dl } = await signedIn({ 'GET /Items': tracks() });
    render(AlbumScreen, { props: { item: album }, context: withContext(app).context });
    await screen.findByText('Second Song');
    await fireEvent.click(screen.getByRole('button', { name: 'Play Second Song' }));
    await flush();
    expect(engine.calls).toContain('load(t2,true)');

    await fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await flush();
    expect(dl.started.map((r) => r.id)).toEqual(['t1', 't2']);
  });

  it('reports a load failure inline', async () => {
    const { app } = await signedIn({});
    render(AlbumScreen, { props: { item: album }, context: withContext(app).context });
    await screen.findByRole('alert');
  });
});

describe('PlayerBar', () => {
  it('reflects playback state and toggles play/pause', async () => {
    const { app, engine } = await signedIn({ 'GET /Items': tracks() });
    render(PlayerBar, { context: withContext(app).context });
    expect(screen.getByText('Nothing playing')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play' }).hasAttribute('disabled')).toBe(true);

    await app.core.player.playQueue([parseBaseItem(trackJson('t1', 'First Song'))]);
    engine.state('playing');
    await flush();
    expect(screen.getByText('First Song')).toBeTruthy();
    const pause = screen.getByRole('button', { name: 'Pause' });
    await fireEvent.click(pause);
    await flush();
    expect(engine.calls).toContain('pause');

    engine.state('paused');
    await screen.findByRole('button', { name: 'Play' });
  });

  it('shows the bit-perfect badge from the signal path', async () => {
    const { app, engine } = await signedIn();
    render(PlayerBar, { context: withContext(app).context });
    await app.core.player.playQueue([parseBaseItem(trackJson('t1', 'First Song'))]);
    expect(screen.queryByText('Bit-perfect')).toBeNull();
    engine.emit({
      kind: 'signalPathChanged', state: 'playing', trackId: 't1', entryId: null, positionMs: 0,
      durationMs: 0, message: null,
      signalPath: {
        codec: 'flac', sourceSampleRate: 96000, sourceBitDepth: 24, channels: 2, stages: [],
        deviceName: 'DAC', outputSampleRate: 96000, outputBitDepth: 24, exclusive: true, bitPerfect: true,
      },
    });
    await screen.findByText('Bit-perfect');
  });
});

describe('Shell', () => {
  it('Space toggles playback outside inputs and navigation works with back', async () => {
    const { app, engine } = await signedIn({ 'GET /Items': tracks(), 'GET /Artists/AlbumArtists': items() });
    render(Shell, { context: new Map([[APP_CONTEXT_KEY, app]]) });
    await app.core.player.playQueue([parseBaseItem(trackJson('t1', 'First Song'))]);
    engine.state('playing');
    await flush();
    await fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    await flush();
    expect(engine.calls).toContain('pause');

    const calls = engine.calls.length;
    const input = document.createElement('input');
    document.body.appendChild(input);
    await fireEvent.keyDown(input, { key: ' ', code: 'Space' });
    await flush();
    expect(engine.calls.length).toBe(calls);
    input.remove();

    await fireEvent.click(screen.getByRole('button', { name: 'Artists' }));
    expect(screen.getByRole('heading', { name: 'Artists' })).toBeTruthy();
  });

  it('opens now playing from the bar and closes it with Escape', async () => {
    const { app } = await signedIn({ 'GET /Items': tracks() });
    render(Shell, { context: new Map([[APP_CONTEXT_KEY, app]]) });
    await app.core.player.playQueue([parseBaseItem(trackJson('t1', 'First Song'))]);
    await flush();
    await fireEvent.click(screen.getByRole('button', { name: 'Open now playing' }));
    await screen.findByRole('region', { name: 'Now playing' });
    await fireEvent.click(screen.getByRole('button', { name: 'Signal path' }));
    await screen.findByRole('dialog');
    // Escape closes only the sheet first.
    await fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('region', { name: 'Now playing' })).toBeTruthy();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Now playing' })).toBeNull());
  });
});

describe('Lyrics', () => {
  const ms = (v: number) => v * 10000;
  const routes = {
    'GET /Audio/t1/Lyrics': {
      Metadata: { IsSynced: true },
      Lyrics: [
        { Start: ms(0), Text: 'line one' },
        { Start: ms(5000), Text: 'line two' },
        { Start: ms(10000), Text: 'line three' },
      ],
    },
  };

  it('highlights the active line as the position advances', async () => {
    const { app } = await signedIn(routes);
    const item = parseBaseItem(trackJson('t1', 'First Song'));
    const { rerender } = render(Lyrics, { props: { item, positionMs: 6000 }, context: withContext(app).context });
    const two = await screen.findByRole('button', { name: 'line two' });
    expect(two.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'line one' }).getAttribute('aria-current')).toBeNull();

    await rerender({ item, positionMs: 12000 });
    expect(screen.getByRole('button', { name: 'line three' }).getAttribute('aria-current')).toBe('true');
    expect(two.getAttribute('aria-current')).toBeNull();
  });

  it('falls back to plain text and to a notice', async () => {
    const plain = await signedIn({
      'GET /Audio/t1/Lyrics': { Metadata: { IsSynced: false }, Lyrics: [{ Text: 'just words' }] },
    });
    const item = parseBaseItem(trackJson('t1', 'First Song'));
    render(Lyrics, { props: { item, positionMs: 0 }, context: withContext(plain.app).context });
    await screen.findByText('just words');
    cleanup();

    const none = await signedIn({});
    render(Lyrics, { props: { item, positionMs: 0 }, context: withContext(none.app).context });
    await screen.findByText('No lyrics for this track.');
  });
});

describe('Sheet', () => {
  it('closes on Escape and via the close button', async () => {
    const onclose = vi.fn();
    const children = createRawSnippet(() => ({ render: () => '<p>inside</p>' }));
    render(Sheet, { props: { title: 'Demo', onclose, children } });
    expect(screen.getByRole('dialog', { name: 'Demo' })).toBeTruthy();
    expect(screen.getByText('inside')).toBeTruthy();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onclose).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onclose).toHaveBeenCalledTimes(2);
  });
});
