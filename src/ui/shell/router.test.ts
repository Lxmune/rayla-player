import { describe, expect, it } from 'vitest';
import { parseBaseItem } from '../../lib/jellyfin/models';
import { Router } from './router.svelte';

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
    expect(r.section).toBe('albums');
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

  it('ignores items without a screen', () => {
    const r = new Router();
    r.open(parseBaseItem({ Id: 't', Name: 'T', Type: 'Audio' }));
    expect(r.stack).toHaveLength(1);
  });
});
