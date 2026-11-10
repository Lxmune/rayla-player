import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBaseItem } from '../../lib/jellyfin/models';
import { flush, trackJson } from '../../lib/test-support';
import AddToPlaylistSheet from '../sheets/AddToPlaylistSheet.svelte';
import { signedIn, withContext } from '../testing';
import AlbumScreen from './AlbumScreen.svelte';
import DiscoverScreen from './DiscoverScreen.svelte';
import HomeScreen from './HomeScreen.svelte';
import SearchScreen from './SearchScreen.svelte';
import StatsScreen from './StatsScreen.svelte';
import { listensKey } from '../../lib/stats/listen-log.svelte';
import { toListenEntry } from '../../lib/stats/aggregate';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

const items = (...ts: Record<string, unknown>[]) => ({ Items: ts, TotalRecordCount: ts.length, StartIndex: 0 });
const albumJson = { Id: 'al1', Name: 'Great Album', Type: 'MusicAlbum', AlbumArtist: 'Artist', ChildCount: 10 };

describe('HomeScreen', () => {
  it('renders shelves and quick-play tiles for a populated library', async () => {
    const { app } = await signedIn({ 'GET /Items': items(albumJson) });
    render(HomeScreen, { context: withContext(app).context });
    await screen.findByRole('heading', { name: 'Recently added' });
    expect(screen.getByRole('heading', { name: 'Recently played' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Rediscover' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Good (morning|afternoon|evening|night)$/ })).toBeTruthy();
    expect((await screen.findAllByRole('button', { name: 'Play Great Album' })).length).toBeGreaterThan(0);
  });

  it('hides shelves that have no items', async () => {
    const { app } = await signedIn({ 'GET /Items': items() });
    render(HomeScreen, { context: withContext(app).context });
    await screen.findByText(/library looks empty/);
    expect(screen.queryByRole('heading', { name: 'Recently added' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Most played' })).toBeNull();
  });
});

describe('DiscoverScreen', () => {
  it('asks for more listening when there is no history', async () => {
    const { app } = await signedIn({ 'GET /Items': items() });
    render(DiscoverScreen, { context: withContext(app).context });
    await screen.findByText(/Play more music to get recommendations/);
    expect(screen.getByRole('heading', { name: 'Discover' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Recommended albums' })).toBeNull();
  });

  it('shows recommendation sections built from history and hides empty ones', async () => {
    const played = Array.from({ length: 6 }, (_, i) => ({
      ...trackJson(`h${i}`, `Hit ${i}`),
      GenreItems: [{ Id: 'g1', Name: 'Metal' }],
      ArtistItems: [{ Id: 'ar1', Name: 'Artist' }],
      UserData: { PlayCount: 10, LastPlayedDate: '2020-01-01T00:00:00Z' },
    }));
    const { app } = await signedIn({ 'GET /Items': items(...played) });
    render(DiscoverScreen, { context: withContext(app).context });
    await screen.findByRole('heading', { name: 'Rediscover' });
    expect(screen.queryByRole('heading', { name: 'Deep cuts' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh recommendations' })).toBeTruthy();
  });
});

describe('AddToPlaylistSheet', () => {
  const tracks = [parseBaseItem(trackJson('t1', 'First Song'))];
  const playlists = items({ Id: 'p1', Name: 'Road Trip', Type: 'Playlist', ChildCount: 3 });

  it('adds the tracks to the chosen playlist and closes', async () => {
    const { app, http } = await signedIn({ 'GET /Items': playlists, 'POST /Playlists/p1/Items': {} });
    const onclose = vi.fn();
    render(AddToPlaylistSheet, { props: { tracks, onclose }, context: withContext(app).context });
    await fireEvent.click(await screen.findByRole('button', { name: /Road Trip/ }));
    await waitFor(() => expect(onclose).toHaveBeenCalled());
    const req = http.requests.find((r) => r.method === 'POST' && r.path === '/Playlists/p1/Items');
    expect(req?.query.Ids).toBe('t1');
  });

  it('creates a new playlist with the tracks', async () => {
    const { app, http } = await signedIn({ 'GET /Items': playlists, 'POST /Playlists': { Id: 'new1' } });
    const onclose = vi.fn();
    render(AddToPlaylistSheet, { props: { tracks, onclose }, context: withContext(app).context });
    await screen.findByRole('button', { name: /Road Trip/ });
    await fireEvent.input(screen.getByLabelText('New playlist name'), { target: { value: 'Fresh' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onclose).toHaveBeenCalled());
    const req = http.requests.find((r) => r.method === 'POST' && r.path === '/Playlists');
    expect(req?.body).toMatchObject({ Name: 'Fresh', Ids: ['t1'] });
  });

  it('filters playlists by name', async () => {
    const { app } = await signedIn({ 'GET /Items': playlists });
    render(AddToPlaylistSheet, { props: { tracks, onclose: () => {} }, context: withContext(app).context });
    await screen.findByRole('button', { name: /Road Trip/ });
    await fireEvent.input(screen.getByLabelText('Filter playlists'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matching playlists.')).toBeTruthy();
  });
});

describe('SearchScreen', () => {
  it('records a recent search when a result is opened', async () => {
    const { app } = await signedIn({ 'GET /Items': items(albumJson) });
    const ctx = withContext(app);
    ctx.ui.searchTerm = 'great';
    render(SearchScreen, { context: ctx.context });
    const open = (await screen.findAllByRole("button", { name: /Great Album/ }, { timeout: 2000 }))[0]!;
    await fireEvent.click(open);
    expect(JSON.parse(localStorage.getItem('rayla.recentSearches') ?? '[]')).toEqual(['great']);
    expect(ctx.router.current.name).toBe('album');
  });

  it('records on Enter and lists recents when the term is empty', async () => {
    const { app } = await signedIn({ 'GET /Items': items() });
    const ctx = withContext(app);
    render(SearchScreen, { context: ctx.context });
    const input = screen.getByLabelText('Search the library') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'queen' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(localStorage.getItem('rayla.recentSearches')).toContain('queen');
    await screen.findByText('No results.', {}, { timeout: 2000 });

    await fireEvent.input(input, { target: { value: '' } });
    await fireEvent.click(await screen.findByRole('button', { name: 'queen' }));
    expect(ctx.ui.searchTerm).toBe('queen');
  });
});

describe('album hero', () => {
  it('shows the format badge and kind from the first track', async () => {
    const { app } = await signedIn({
      'GET /Items': items(trackJson('t1', 'First Song', { index: 1 }), trackJson('t2', 'Second Song', { index: 2 })),
    });
    render(AlbumScreen, { props: { item: parseBaseItem(albumJson) }, context: withContext(app).context });
    await screen.findByText('First Song');
    await flush();
    expect(screen.getByText('FLAC · 24/96')).toBeTruthy();
    expect(screen.getByText('Single')).toBeTruthy();
    expect(screen.getByText('2 tracks')).toBeTruthy();
  });
});

describe('DiscoverScreen daily mixes', () => {
  it('shows a Daily mixes shelf built from the history and saves one as a playlist', async () => {
    const played = Array.from({ length: 18 }, (_, i) => ({
      ...trackJson(`h${i}`, `Hit ${i}`),
      GenreItems: [{ Id: 'g1', Name: 'Metal' }],
      ArtistItems: [{ Id: `ar${i % 6}`, Name: `Artist ${i % 6}` }],
      AlbumId: `al${i}`,
      UserData: { PlayCount: 5, LastPlayedDate: '2020-01-01T00:00:00Z' },
    }));
    const { app, http } = await signedIn({ 'GET /Items': items(...played), 'POST /Playlists': { Id: 'np' } });
    const { context, ui } = withContext(app);
    render(DiscoverScreen, { context });
    await screen.findByRole('heading', { name: 'Daily mixes' });
    expect(screen.getByRole('button', { name: 'Play Metal mix' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'More options for Metal mix' }));
    const entry = ui.menu?.entries.find((e) => e !== 'separator' && e.label === 'Save as playlist');
    expect(entry).toBeTruthy();
    if (entry && entry !== 'separator') entry.onselect();
    await waitFor(() => expect(http.requests.some((r) => r.method === 'POST' && r.path === '/Playlists')).toBe(true));
  });
});

describe('StatsScreen', () => {
  it('falls back to server play counts when the local log is empty', async () => {
    const played = [{ ...trackJson('s1', 'Server Song'), UserData: { PlayCount: 4 }, ArtistItems: [{ Id: 'a1', Name: 'Server Artist' }] }];
    const { app } = await signedIn({ 'GET /Items': items(...played) });
    render(StatsScreen, { context: withContext(app).context });
    await screen.findByText('Based on server play counts');
    await screen.findByRole('heading', { name: 'Top tracks' });
    expect(screen.getByText('Server Artist', { selector: '.name' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Period' })).toBeNull();
  });

  it('uses the local listening log with a period switch', async () => {
    const { app } = await signedIn({ 'GET /Items': items() });
    const id = app.core.sessions.activeId as string;
    const t = parseBaseItem({ ...trackJson('l1', 'Local Song'), ArtistItems: [{ Id: 'a9', Name: 'Local Artist' }] });
    const now = Date.now();
    app.kv.set(listensKey(id), JSON.stringify([
      toListenEntry(t, 180_000, now - 3_600_000),
      toListenEntry(parseBaseItem({ ...trackJson('l2', 'Old Song'), ArtistItems: [{ Id: 'a8', Name: 'Old Artist' }] }), 60_000, now - 90 * 86_400_000),
    ]));
    render(StatsScreen, { context: withContext(app).context });
    await screen.findByRole('heading', { name: 'Top artists' });
    expect(screen.getAllByText('Local Artist').length).toBeGreaterThan(0);
    expect(screen.queryByText('Old Artist')).toBeNull();
    expect(screen.queryByText('Based on server play counts')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'All time' }));
    expect((await screen.findAllByText('Old Artist')).length).toBeGreaterThan(0);
  });
});
