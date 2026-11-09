import { describe, expect, it } from 'vitest';
import { FakeHttp, FakeStatus, fakeClient, track, trackJson } from '../test-support';
import { JellyfinClient, JellyfinError, describeError } from './client';

describe('JellyfinClient', () => {
  it('authenticate sends the MediaBrowser header and parses the result', async () => {
    const http = new FakeHttp({
      'POST /Users/AuthenticateByName': {
        AccessToken: 'abc',
        ServerId: 'srv',
        User: { Id: 'u9', Name: 'Ann' },
      },
    });
    const auth = await fakeClient(http, { token: null }).authenticate('ann', 'pw');
    expect(auth).toEqual({ accessToken: 'abc', userId: 'u9', userName: 'Ann', serverId: 'srv' });
    const req = http.requests[0];
    expect(req?.headers['authorization']).toMatch(/^MediaBrowser Client="Rayla"/);
    expect(req?.headers['authorization']).toContain('DeviceId="dev123"');
    expect(req?.headers['authorization']).not.toContain('Token=');
    expect(req?.body).toEqual({ Username: 'ann', Pw: 'pw' });
  });

  it('authenticated requests carry the token', async () => {
    const http = new FakeHttp({ 'GET /Items': { Items: [], TotalRecordCount: 0 } });
    await fakeClient(http).albums();
    expect(http.requests[0]?.headers['authorization']).toContain('Token="tok"');
  });

  it('album tracks are ordered by disc, track, then server order', async () => {
    const http = new FakeHttp({
      'GET /Items': {
        TotalRecordCount: 3,
        Items: [
          trackJson('t2', 'Second', { index: 2, disc: 1, gain: -6.5 }),
          trackJson('t3', 'Third', { index: 1, disc: 2 }),
          trackJson('t1', 'First', { index: 1, disc: 1 }),
        ],
      },
    });
    const tracks = await fakeClient(http).albumTracks('al1');
    expect(tracks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(http.requests[0]?.query['ParentId']).toBe('al1');
    expect(http.requests[0]?.query['userId']).toBe('u1');
  });

  it('stream URL is the original file unless a cap is set', () => {
    const client = fakeClient(new FakeHttp());
    expect(client.streamUrl('x')).toBe('https://jf.test/Audio/x/stream?static=true');
    const capped = new URL(client.streamUrl('x', { maxBitrate: 192000 }));
    expect(capped.pathname).toBe('/Audio/x/universal');
    expect(capped.searchParams.get('MaxStreamingBitrate')).toBe('192000');
    expect(capped.searchParams.get('UserId')).toBe('u1');
    expect(capped.searchParams.get('DeviceId')).toBe('dev123');
    expect(capped.searchParams.get('Container')).toBe('flac,mp3,aac,m4a,ogg,wav');
    expect(capped.searchParams.get('TranscodingContainer')).toBe('mp3');
  });

  it('image, download URLs and auth headers', () => {
    const client = fakeClient(new FakeHttp());
    expect(client.imageUrl('i1', { maxWidth: 300, tag: 'tg' })).toBe(
      'https://jf.test/Items/i1/Images/Primary?maxWidth=300&quality=90&tag=tg',
    );
    expect(client.imageUrl('i1')).toBe('https://jf.test/Items/i1/Images/Primary?maxWidth=600&quality=90');
    expect(client.downloadUrl('i1')).toBe('https://jf.test/Items/i1/Download');
    expect(client.authHeaders()).toEqual([
      { name: 'Authorization', value: client.authorizationHeader },
    ]);
  });

  it('paging passes start index and reports more', async () => {
    const http = new FakeHttp({
      'GET /Items': {
        TotalRecordCount: 5,
        StartIndex: 2,
        Items: [
          { Id: 'a', Name: 'A', Type: 'MusicAlbum' },
          { Id: 'b', Name: 'B', Type: 'MusicAlbum' },
        ],
      },
    });
    const page = await fakeClient(http).albums({ startIndex: 2, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.startIndex + page.items.length < page.totalRecordCount).toBe(true);
    const q = http.requests[0]?.query;
    expect([q?.['StartIndex'], q?.['Limit']]).toEqual(['2', '2']);
    expect(q?.['IncludeItemTypes']).toBe('MusicAlbum');
    expect(q?.['AlbumArtistIds']).toBeUndefined();
  });

  it('album filters and sort options become query parameters', async () => {
    const http = new FakeHttp({ 'GET /Items': { Items: [] } });
    const c = fakeClient(http);
    await c.albums({ artistId: 'ar', genreId: 'g', favoritesOnly: true, descending: true, sortBy: 'DateCreated' });
    await c.recentlyAddedAlbums();
    await c.artistAlbums('ar2');
    const [a, r, ar] = http.requests.map((x) => x.query);
    expect(a).toMatchObject({
      AlbumArtistIds: 'ar',
      GenreIds: 'g',
      Filters: 'IsFavorite',
      SortOrder: 'Descending',
      SortBy: 'DateCreated',
    });
    expect(r).toMatchObject({ SortBy: 'DateCreated,SortName', SortOrder: 'Descending', Limit: '24' });
    expect(ar).toMatchObject({ AlbumArtistIds: 'ar2', SortBy: 'ProductionYear,SortName' });
  });

  it('list endpoints hit the right paths', async () => {
    const http = new FakeHttp({
      'GET /Artists/AlbumArtists': { Items: [] },
      'GET /Items': { Items: [] },
      'GET /Playlists/p1/Items': { Items: [] },
      'GET /MusicGenres': { Items: [] },
    });
    const c = fakeClient(http);
    await c.albumArtists();
    await c.playlists();
    await c.playlistItems('p1');
    await c.genres();
    expect(http.paths).toEqual(['/Artists/AlbumArtists', '/Items', '/Playlists/p1/Items', '/MusicGenres']);
    expect(http.requests[1]?.query['IncludeItemTypes']).toBe('Playlist');
    expect(http.requests[2]?.query['Limit']).toBeUndefined();
    expect(http.requests[3]?.query['Limit']).toBe('200');
  });

  it('search splits results by type', async () => {
    const http = new FakeHttp({
      'GET /Items': {
        Items: [
          { Id: 'a', Type: 'MusicArtist' },
          { Id: 'b', Type: 'MusicAlbum' },
          trackJson('c', 'C'),
        ],
      },
    });
    const r = await fakeClient(http).search('foo', 10);
    expect(r.artists.map((i) => i.id)).toEqual(['a']);
    expect(r.albums.map((i) => i.id)).toEqual(['b']);
    expect(r.tracks.map((i) => i.id)).toEqual(['c']);
    expect(http.requests[0]?.query).toMatchObject({ searchTerm: 'foo', Limit: '10' });
  });

  it('favorites use POST and DELETE on the user endpoint', async () => {
    const http = new FakeHttp({
      'POST /Users/u1/FavoriteItems/x': {},
      'DELETE /Users/u1/FavoriteItems/x': {},
    });
    const c = fakeClient(http);
    await c.setFavorite('x', true);
    await c.setFavorite('x', false);
    expect(http.requests.map((r) => r.method)).toEqual(['POST', 'DELETE']);
  });

  it('playback reports hit the session endpoints with ticks', async () => {
    const http = new FakeHttp({
      'POST /Sessions/Playing': {},
      'POST /Sessions/Playing/Progress': {},
      'POST /Sessions/Playing/Stopped': {},
    });
    const c = fakeClient(http);
    await c.reportPlaybackStart('t1');
    await c.reportPlaybackProgress('t1', 2000, { paused: true });
    await c.reportPlaybackStopped('t1', 3000);
    expect(http.paths).toEqual([
      '/Sessions/Playing',
      '/Sessions/Playing/Progress',
      '/Sessions/Playing/Stopped',
    ]);
    const body = http.requests[1]?.body as Record<string, unknown>;
    expect(body['PositionTicks']).toBe(20000000);
    expect(body['IsPaused']).toBe(true);
    expect(body['PlayMethod']).toBe('DirectPlay');
  });

  it('progress reports carry what remote clients need', async () => {
    const http = new FakeHttp({ 'POST /Sessions/Playing/Progress': {} });
    await fakeClient(http).reportPlaybackProgress('t1', 1000, {
      transcoding: true,
      extra: { VolumeLevel: 40, RepeatMode: 'RepeatAll' },
    });
    const body = http.requests[0]?.body as Record<string, unknown>;
    expect(body['VolumeLevel']).toBe(40);
    expect(body['RepeatMode']).toBe('RepeatAll');
    expect(body['PlayMethod']).toBe('Transcode');
  });

  it('server URL normalisation', () => {
    expect(JellyfinClient.normalizeServerUrl(' jf.local:8096/ ')).toBe('http://jf.local:8096');
    expect(JellyfinClient.normalizeServerUrl('https://x.org///')).toBe('https://x.org');
    expect(JellyfinClient.normalizeServerUrl('  ')).toBe('');
  });

  it('instant mix hits /Items/{id}/InstantMix with user and limit', async () => {
    const http = new FakeHttp({
      'GET /Items/seed/InstantMix': {
        TotalRecordCount: 2,
        Items: [trackJson('m1', 'One'), trackJson('m2', 'Two')],
      },
    });
    const mix = await fakeClient(http).instantMix('seed', 25);
    expect(mix.map((t) => t.id)).toEqual(['m1', 'm2']);
    const q = http.requests[0]?.query;
    expect(q?.['userId']).toBe('u1');
    expect(q?.['Limit']).toBe('25');
    expect(q?.['Fields']).toContain('MediaSources');
  });

  it('itemsByIds keeps the requested order and drops unknown ids', async () => {
    const http = new FakeHttp({
      'GET /Items': { Items: [trackJson('b', 'B'), trackJson('a', 'A')] },
    });
    const c = fakeClient(http);
    const items = await c.itemsByIds(['a', 'nope', 'b']);
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(http.requests[0]?.query['Ids']).toBe('a,nope,b');
    expect(await c.itemsByIds([])).toEqual([]);
    expect(http.requests).toHaveLength(1);
  });

  it('tracksOf expands containers and passes tracks through', async () => {
    const http = new FakeHttp({
      'GET /Items': { Items: [trackJson('t1', 'One', { index: 1 })] },
      'GET /Playlists/p/Items': { Items: [trackJson('p1', 'P')] },
    });
    const c = fakeClient(http);
    const t = track('solo');
    expect(await c.tracksOf(t)).toEqual([t]);
    expect((await c.tracksOf({ ...t, id: 'al', type: 'MusicAlbum' })).map((i) => i.id)).toEqual(['t1']);
    expect((await c.tracksOf({ ...t, id: 'p', type: 'Playlist' })).map((i) => i.id)).toEqual(['p1']);
    expect(await c.tracksOf({ ...t, type: 'Genre' })).toEqual([]);
    expect(http.requests[0]?.query['ParentId']).toBe('al');
  });

  it('capabilities request announces audio remote control', async () => {
    const http = new FakeHttp({ 'POST /Sessions/Capabilities/Full': {} });
    await fakeClient(http).postCapabilities();
    const body = http.requests[0]?.body as Record<string, unknown>;
    expect(body['PlayableMediaTypes']).toEqual(['Audio']);
    expect(body['SupportsMediaControl']).toBe(true);
    expect(body['SupportedCommands']).toEqual(
      expect.arrayContaining(['SetVolume', 'Mute', 'Unmute', 'ToggleMute']),
    );
  });

  it('websocket URL uses ws(s), api_key and deviceId', () => {
    expect(fakeClient(new FakeHttp()).socketUrl).toBe('wss://jf.test/socket?api_key=tok&deviceId=dev123');
    const plain = new JellyfinClient({
      baseUrl: 'http://h:8096/jf',
      deviceId: 'd',
      fetch: new FakeHttp().fetch,
    });
    expect(plain.socketUrl).toBe('ws://h:8096/jf/socket?deviceId=d');
  });

  describe('lyrics', () => {
    it('requests /Audio/{id}/Lyrics and maps HTTP errors to null', async () => {
      const http = new FakeHttp({
        'GET /Audio/t1/Lyrics': {
          Metadata: { IsSynced: true },
          Lyrics: [{ Text: 'x', Start: 10000000 }],
        },
      });
      const c = fakeClient(http);
      const l = await c.lyrics('t1');
      expect(l?.lines[0]?.text).toBe('x');
      expect(l?.lines[0]?.startMs).toBe(1000);
      expect(http.paths[0]).toBe('/Audio/t1/Lyrics');
      expect(await c.lyrics('missing')).toBeNull(); // 404
    });

    it('an empty lyrics document is treated as none', async () => {
      const http = new FakeHttp({ 'GET /Audio/t1/Lyrics': { Lyrics: [], Metadata: {} } });
      expect(await fakeClient(http).lyrics('t1')).toBeNull();
    });

    it('network failures still throw', async () => {
      const http = new FakeHttp();
      http.failWith = new Error('offline');
      await expect(fakeClient(http).lyrics('t1')).rejects.toBeInstanceOf(JellyfinError);
    });
  });

  describe('errors', () => {
    it('maps HTTP status and network failures to friendly messages', async () => {
      const http = new FakeHttp({
        'POST /Users/AuthenticateByName': new FakeStatus(401),
        'GET /Artists/AlbumArtists': new FakeStatus(500),
      });
      const c = fakeClient(http);
      const e401 = await c.authenticate('a', 'b').catch((e: unknown) => e);
      expect(describeError(e401)).toBe('Invalid username or password.');
      const e500 = await c.albumArtists().catch((e: unknown) => e);
      expect(describeError(e500)).toBe('Server responded with HTTP 500.');
      http.failWith = new Error('boom');
      const net = await c.albumArtists().catch((e: unknown) => e);
      expect((net as JellyfinError).kind).toBe('network');
      expect(describeError(net)).toBe('Could not reach the server.');
      expect(describeError(new JellyfinError('timeout', null, 't'))).toBe('Connection timed out.');
      expect(describeError(new Error('plain'))).toBe('plain');
    });
  });
});
