import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBaseItem } from '../../lib/jellyfin/models';
import { flush, trackJson } from '../../lib/test-support';
import SongsScreen from '../browse/SongsScreen.svelte';
import { signedIn, withContext } from '../testing';
import Card from './Card.svelte';
import TrackList from './TrackList.svelte';
import { loadViewPrefs, saveViewPrefs } from './viewPrefs';

afterEach(() => cleanup());

const page = (...ts: Record<string, unknown>[]) => ({ Items: ts, TotalRecordCount: ts.length, StartIndex: 0 });

describe('viewPrefs', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips and merges', () => {
    expect(loadViewPrefs('x')).toEqual({});
    saveViewPrefs('x', { sort: 'added' });
    saveViewPrefs('x', { view: 'list' });
    expect(loadViewPrefs('x')).toEqual({ sort: 'added', view: 'list' });
    expect(localStorage.getItem('rayla.view.x')).toContain('added');
  });

  it('drops invalid or stale values', () => {
    localStorage.setItem('rayla.view.x', JSON.stringify({ sort: 'gone', view: 'tiles' }));
    expect(loadViewPrefs('x', ['name'])).toEqual({});
    localStorage.setItem('rayla.view.x', 'not json');
    expect(loadViewPrefs('x')).toEqual({});
    localStorage.setItem('rayla.view.x', '5');
    expect(loadViewPrefs('x')).toEqual({});
  });
});

describe('Card', () => {
  const album = parseBaseItem({ Id: 'al1', Name: 'Great Album', Type: 'MusicAlbum', AlbumArtist: 'Artist' });

  it('opens on click; the play button plays without opening', async () => {
    const { app, engine } = await signedIn({ 'GET /Items': page(trackJson('t1', 'First Song')) });
    let opened = 0;
    render(Card, { props: { item: album, onclick: () => opened++ }, context: withContext(app).context });
    await fireEvent.click(screen.getByRole('button', { name: 'Play Great Album' }));
    await flush();
    expect(opened).toBe(0);
    expect(engine.calls).toContain('load(t1,true)');
    await fireEvent.click(screen.getByText('Great Album').closest('button')!);
    expect(opened).toBe(1);
  });

  it('has a more button', async () => {
    const { app } = await signedIn();
    render(Card, { props: { item: album, onclick: () => {} }, context: withContext(app).context });
    expect(screen.getByRole('button', { name: 'More options for Great Album' })).toBeTruthy();
  });
});

describe('TrackList', () => {
  it('shows disc headings only with more than one disc', async () => {
    const { app } = await signedIn();
    const mk = (id: string, disc: number) => parseBaseItem(trackJson(id, `Song ${id}`, { disc, index: 1 }));
    const two = [mk('a', 1), mk('b', 2)];
    const view = render(TrackList, { props: { tracks: two, onplay: () => {}, discs: true }, context: withContext(app).context });
    expect(screen.getByText('Disc 1')).toBeTruthy();
    expect(screen.getByText('Disc 2')).toBeTruthy();
    view.unmount();
    render(TrackList, { props: { tracks: [mk('a', 1)], onplay: () => {}, discs: true }, context: withContext(app).context });
    expect(screen.queryByText('Disc 1')).toBeNull();
  });

  it('plays the clicked index and moves focus with arrow keys', async () => {
    const { app } = await signedIn();
    const tracks = [parseBaseItem(trackJson('a', 'Song A')), parseBaseItem(trackJson('b', 'Song B'))];
    const played: number[] = [];
    render(TrackList, { props: { tracks, onplay: (i: number) => played.push(i) }, context: withContext(app).context });
    const a = screen.getByRole('button', { name: 'Play Song A' });
    a.focus();
    await fireEvent.keyDown(a, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Play Song B' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Play Song B' }));
    expect(played).toEqual([1]);
  });
});

describe('SongsScreen', () => {
  it('lists tracks, plays from a row and Play all queues them', async () => {
    const { app, engine } = await signedIn({
      'GET /Items': page(trackJson('t1', 'First Song'), trackJson('t2', 'Second Song')),
    });
    render(SongsScreen, { context: withContext(app).context });
    await screen.findByText('First Song');

    await fireEvent.click(screen.getByRole('button', { name: 'Play Second Song' }));
    await flush();
    expect(engine.calls).toContain('load(t2,true)');

    await fireEvent.click(screen.getByRole('button', { name: 'Play all' }));
    await waitFor(() => expect(engine.calls).toContain('load(t1,true)'));
    expect(app.core.player.queue).toHaveLength(2);
  });
});
