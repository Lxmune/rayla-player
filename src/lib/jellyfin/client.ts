// Thin Jellyfin HTTP client for one server (and, once authenticated, one user).
// All network access goes through the injected HttpFetch.

import type { HttpHeader } from '../ipc';
import type { HttpFetch } from '../platform';
import {
  DIRECT_STREAM_CONTAINERS,
  parseAuthResult,
  parseItemsPage,
  parseLyrics,
  lyricsIsEmpty,
  type AuthResult,
  type BaseItem,
  type ItemsPage,
  type Lyrics,
  type SearchResults,
} from './models';

export const CLIENT_NAME = 'Rayla';
export const CLIENT_VERSION = '1.0.0';

const REQUEST_TIMEOUT_MS = 30_000;

type QueryValue = string | number | boolean | null | undefined;
type Query = Record<string, QueryValue>;

export type JellyfinErrorKind = 'http' | 'timeout' | 'network';

export class JellyfinError extends Error {
  constructor(
    readonly kind: JellyfinErrorKind,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'JellyfinError';
  }
}

/** A short, user-presentable message for a failed request. */
export function describeError(error: unknown): string {
  if (error instanceof JellyfinError) {
    if (error.kind === 'http') {
      return error.status === 401
        ? 'Invalid username or password.'
        : `Server responded with HTTP ${error.status}.`;
    }
    return error.kind === 'timeout' ? 'Connection timed out.' : 'Could not reach the server.';
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface JellyfinClientOptions {
  baseUrl: string;
  deviceId: string;
  deviceName?: string;
  token?: string | null;
  userId?: string | null;
  fetch: HttpFetch;
}

export interface AlbumsQuery {
  artistId?: string | null;
  genreId?: string | null;
  favoritesOnly?: boolean;
  /** Only items the user has played (use with sortBy 'DatePlayed' / 'PlayCount'). */
  playedOnly?: boolean;
  sortBy?: string;
  descending?: boolean;
  startIndex?: number;
  limit?: number;
}

/** Tracks across the library (all songs, favorites, recently / most played, genre, artist). */
export type TracksQuery = AlbumsQuery;

function filters(opts: AlbumsQuery): string | null {
  const f = [opts.favoritesOnly ? 'IsFavorite' : null, opts.playedOnly ? 'IsPlayed' : null].filter(Boolean);
  return f.length > 0 ? f.join(',') : null;
}

/** Extra fields remote controllers display (see the report* methods). */
export type PlaybackExtra = Record<string, unknown>;

const ITEM_FIELDS = 'MediaSources,DateCreated,ChildCount';

export const REMOTE_COMMANDS = [
  'VolumeUp',
  'VolumeDown',
  'Mute',
  'Unmute',
  'ToggleMute',
  'SetVolume',
  'SetRepeatMode',
  'SetShuffleQueue',
] as const;

export class JellyfinClient {
  readonly baseUrl: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly token: string | null;
  readonly userId: string | null;
  private readonly fetchFn: HttpFetch;

  constructor(opts: JellyfinClientOptions) {
    this.baseUrl = JellyfinClient.normalizeServerUrl(opts.baseUrl);
    this.deviceId = opts.deviceId;
    this.deviceName = opts.deviceName ?? 'Desktop';
    this.token = opts.token ?? null;
    this.userId = opts.userId ?? null;
    this.fetchFn = opts.fetch;
  }

  /** Trims, adds a scheme when missing and strips trailing slashes. */
  static normalizeServerUrl(input: string): string {
    let url = input.trim();
    if (url === '') return url;
    if (!url.includes('://')) url = `http://${url}`;
    while (url.endsWith('/')) url = url.slice(0, -1);
    return url;
  }

  /** `MediaBrowser Client="Rayla", Device=..., DeviceId=..., Version=...[, Token=...]` */
  get authorizationHeader(): string {
    const q = (v: string) => `"${v.replaceAll('"', '')}"`;
    const parts = [
      `Client=${q(CLIENT_NAME)}`,
      `Device=${q(this.deviceName)}`,
      `DeviceId=${q(this.deviceId)}`,
      `Version=${q(CLIENT_VERSION)}`,
      ...(this.token !== null ? [`Token=${q(this.token)}`] : []),
    ];
    return `MediaBrowser ${parts.join(', ')}`;
  }

  /** Headers the engine / downloader must send with media URLs. */
  authHeaders(): HttpHeader[] {
    return [{ name: 'Authorization', value: this.authorizationHeader }];
  }

  // ------------------------------------------------------------- transport

  private url(path: string, query?: Query): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== null && v !== undefined) params.append(k, String(v));
    }
    const qs = params.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: this.authorizationHeader,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const controller = new AbortController();
    init.signal = controller.signal;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await this.fetchFn(this.url(path, opts.query), init);
      } catch (e) {
        if (timedOut) throw new JellyfinError('timeout', null, 'Connection timed out.');
        throw new JellyfinError('network', null, e instanceof Error ? e.message : String(e));
      }
      if (!res.ok) throw new JellyfinError('http', res.status, `HTTP ${res.status}`);
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw new JellyfinError(
          timedOut ? 'timeout' : 'network',
          null,
          'Failed to read the response.',
        );
      }
      if (text.trim() === '') return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------ auth

  async authenticate(username: string, password: string): Promise<AuthResult> {
    const json = await this.request('POST', '/Users/AuthenticateByName', {
      body: { Username: username, Pw: password },
    });
    return parseAuthResult(json);
  }

  // -------------------------------------------------------------- browsing

  private async items(path: string, query: Query): Promise<ItemsPage> {
    const json = await this.request('GET', path, {
      query: { userId: this.userId, ...query },
    });
    return parseItemsPage(json);
  }

  albumArtists(opts: { startIndex?: number; limit?: number } = {}): Promise<ItemsPage> {
    return this.items('/Artists/AlbumArtists', {
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      StartIndex: opts.startIndex ?? 0,
      Limit: opts.limit ?? 100,
    });
  }

  /** Albums, optionally narrowed to an album artist and/or genre. */
  albums(opts: AlbumsQuery = {}): Promise<ItemsPage> {
    return this.items('/Items', {
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      AlbumArtistIds: opts.artistId,
      GenreIds: opts.genreId,
      Filters: filters(opts),
      SortBy: opts.sortBy ?? 'SortName',
      SortOrder: opts.descending ? 'Descending' : 'Ascending',
      Fields: 'DateCreated,ChildCount',
      StartIndex: opts.startIndex ?? 0,
      Limit: opts.limit ?? 100,
    });
  }

  /** Tracks, optionally narrowed (artist matches any credited artist). */
  tracks(opts: TracksQuery = {}): Promise<ItemsPage> {
    return this.items('/Items', {
      IncludeItemTypes: 'Audio',
      Recursive: true,
      ArtistIds: opts.artistId,
      GenreIds: opts.genreId,
      Filters: filters(opts),
      SortBy: opts.sortBy ?? 'SortName',
      SortOrder: opts.descending ? 'Descending' : 'Ascending',
      Fields: ITEM_FIELDS,
      StartIndex: opts.startIndex ?? 0,
      Limit: opts.limit ?? 100,
    });
  }

  /** Items similar to an artist or album (same type as the seed). */
  similar(itemId: string, limit = 12): Promise<ItemsPage> {
    return this.items(`/Items/${itemId}/Similar`, { Limit: limit, Fields: 'DateCreated,ChildCount' });
  }

  recentlyAddedAlbums(opts: { startIndex?: number; limit?: number } = {}): Promise<ItemsPage> {
    return this.albums({
      sortBy: 'DateCreated,SortName',
      descending: true,
      startIndex: opts.startIndex ?? 0,
      limit: opts.limit ?? 24,
    });
  }

  /** Albums of one album artist, oldest first. */
  artistAlbums(artistId: string): Promise<ItemsPage> {
    return this.albums({ artistId, sortBy: 'ProductionYear,SortName' });
  }

  /** Tracks of an album, ordered by disc then track number. */
  async albumTracks(albumId: string): Promise<BaseItem[]> {
    const page = await this.items('/Items', {
      ParentId: albumId,
      IncludeItemTypes: 'Audio',
      SortBy: 'ParentIndexNumber,IndexNumber,SortName',
      Fields: ITEM_FIELDS,
    });
    // Servers sort nulls inconsistently; make the order deterministic here.
    const indexed = page.items.map((item, i) => ({ item, i }));
    indexed.sort((a, b) => {
      const disc = (a.item.parentIndexNumber ?? 1) - (b.item.parentIndexNumber ?? 1);
      if (disc !== 0) return disc;
      const track = (a.item.indexNumber ?? 0) - (b.item.indexNumber ?? 0);
      return track !== 0 ? track : a.i - b.i;
    });
    return indexed.map((e) => e.item);
  }

  playlists(opts: { startIndex?: number; limit?: number } = {}): Promise<ItemsPage> {
    return this.items('/Items', {
      IncludeItemTypes: 'Playlist',
      Recursive: true,
      SortBy: 'SortName',
      Fields: 'ChildCount',
      StartIndex: opts.startIndex ?? 0,
      Limit: opts.limit ?? 100,
    });
  }

  playlistItems(
    playlistId: string,
    opts: { startIndex?: number; limit?: number | null } = {},
  ): Promise<ItemsPage> {
    return this.items(`/Playlists/${playlistId}/Items`, {
      Fields: ITEM_FIELDS,
      StartIndex: opts.startIndex ?? 0,
      Limit: opts.limit,
    });
  }

  genres(opts: { startIndex?: number; limit?: number } = {}): Promise<ItemsPage> {
    return this.items('/MusicGenres', {
      SortBy: 'SortName',
      StartIndex: opts.startIndex ?? 0,
      Limit: opts.limit ?? 200,
    });
  }

  async search(term: string, limit = 60): Promise<SearchResults> {
    const page = await this.items('/Items', {
      searchTerm: term,
      IncludeItemTypes: 'MusicArtist,MusicAlbum,Audio',
      Recursive: true,
      Fields: ITEM_FIELDS,
      Limit: limit,
    });
    const of = (type: string) => page.items.filter((i) => i.type === type);
    return { artists: of('MusicArtist'), albums: of('MusicAlbum'), tracks: of('Audio') };
  }

  // -------------------------------------------------------------- playlists

  /** Creates an audio playlist with `itemIds`; resolves to its id. */
  async createPlaylist(name: string, itemIds: string[] = []): Promise<string> {
    const json = await this.request('POST', '/Playlists', {
      body: { Name: name, Ids: itemIds, UserId: this.userId, MediaType: 'Audio' },
    });
    const id = typeof json === 'object' && json !== null ? (json as { Id?: unknown }).Id : null;
    if (typeof id !== 'string' || id === '') throw new JellyfinError('http', null, 'Playlist was not created.');
    return id;
  }

  async addToPlaylist(playlistId: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    await this.request('POST', `/Playlists/${playlistId}/Items`, {
      query: { Ids: itemIds.join(','), UserId: this.userId },
    });
  }

  /** Removes entries by their `playlistItemId`. */
  async removeFromPlaylist(playlistId: string, entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) return;
    await this.request('DELETE', `/Playlists/${playlistId}/Items`, {
      query: { EntryIds: entryIds.join(',') },
    });
  }

  async setFavorite(itemId: string, favorite: boolean): Promise<void> {
    const path = `/Users/${this.userId}/FavoriteItems/${itemId}`;
    await this.request(favorite ? 'POST' : 'DELETE', path);
  }

  // ------------------------------------------------ lyrics, mixes, lookups

  /**
   * Lyrics of a track, or null when the server has none (404, or a server
   * older than 10.9 without the endpoint). Network failures still throw.
   */
  async lyrics(itemId: string): Promise<Lyrics | null> {
    try {
      const json = await this.request('GET', `/Audio/${itemId}/Lyrics`);
      if (json === null) return null;
      const lyrics = parseLyrics(json);
      return lyricsIsEmpty(lyrics) ? null : lyrics;
    } catch (e) {
      if (e instanceof JellyfinError && e.kind === 'http') return null;
      throw e;
    }
  }

  /** Instant mix seeded from a track, album, artist, playlist or genre. */
  async instantMix(itemId: string, limit = 50): Promise<BaseItem[]> {
    const page = await this.items(`/Items/${itemId}/InstantMix`, {
      Limit: limit,
      Fields: ITEM_FIELDS,
    });
    return page.items;
  }

  /** Items by id, in the order of `ids` (unknown ids are dropped). */
  async itemsByIds(ids: string[]): Promise<BaseItem[]> {
    if (ids.length === 0) return [];
    const page = await this.items('/Items', { Ids: ids.join(','), Fields: ITEM_FIELDS });
    const byId = new Map(page.items.map((i) => [i.id, i]));
    const out: BaseItem[] = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (item) out.push(item);
    }
    return out;
  }

  /** All tracks of an artist. */
  async artistTracks(artistId: string): Promise<BaseItem[]> {
    const page = await this.items('/Items', {
      ArtistIds: artistId,
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'Album,ParentIndexNumber,IndexNumber,SortName',
      Fields: ITEM_FIELDS,
    });
    return page.items;
  }

  /** Tracks of any playable container item (album, playlist, artist); a track is returned as is. */
  async tracksOf(item: BaseItem): Promise<BaseItem[]> {
    switch (item.type) {
      case 'Audio':
        return [item];
      case 'MusicAlbum':
        return this.albumTracks(item.id);
      case 'Playlist':
        return (await this.playlistItems(item.id)).items;
      case 'MusicArtist':
        return this.artistTracks(item.id);
      default:
        return [];
    }
  }

  /** One item by id (null when unknown). */
  async item(itemId: string): Promise<BaseItem | null> {
    const found = await this.itemsByIds([itemId]);
    return found[0] ?? null;
  }

  // -------------------------------------------------------- remote control

  /** Announces that this client can be remote-controlled. */
  async postCapabilities(): Promise<void> {
    await this.request('POST', '/Sessions/Capabilities/Full', {
      body: {
        PlayableMediaTypes: ['Audio'],
        SupportedCommands: [...REMOTE_COMMANDS],
        SupportsMediaControl: true,
        SupportsPersistentIdentifier: true,
      },
    });
  }

  /** `ws(s)://host/socket?api_key=TOKEN&deviceId=DEVICEID`. */
  get socketUrl(): string {
    const params = new URLSearchParams();
    if (this.token !== null) params.append('api_key', this.token);
    params.append('deviceId', this.deviceId);
    return `${this.baseUrl.replace(/^http/i, 'ws')}/socket?${params.toString()}`;
  }

  // ------------------------------------------------------------------ URLs

  imageUrl(itemId: string, opts: { maxWidth?: number; tag?: string | null } = {}): string {
    return this.url(`/Items/${itemId}/Images/Primary`, {
      maxWidth: opts.maxWidth ?? 600,
      quality: 90,
      tag: opts.tag,
    });
  }

  /**
   * The original file by default; with a bitrate cap, the universal endpoint,
   * which lets the server decide between direct stream and transcode.
   */
  streamUrl(itemId: string, opts: { maxBitrate?: number | null } = {}): string {
    const cap = opts.maxBitrate ?? null;
    if (cap === null) return `${this.baseUrl}/Audio/${itemId}/stream?static=true`;
    return this.url(`/Audio/${itemId}/universal`, {
      UserId: this.userId,
      DeviceId: this.deviceId,
      MaxStreamingBitrate: cap,
      Container: DIRECT_STREAM_CONTAINERS.join(','),
      TranscodingContainer: 'mp3',
      TranscodingProtocol: 'http',
      AudioCodec: 'mp3',
    });
  }

  /** URL of the original file (use with `authHeaders()`). */
  downloadUrl(itemId: string): string {
    return `${this.baseUrl}/Items/${itemId}/Download`;
  }

  // ----------------------------------------------------- playback reporting

  private playbackInfo(
    itemId: string,
    positionMs: number,
    paused: boolean,
    transcoding: boolean,
    extra: PlaybackExtra,
  ): Record<string, unknown> {
    return {
      ItemId: itemId,
      PositionTicks: Math.round(positionMs * 10000),
      IsPaused: paused,
      CanSeek: true,
      PlayMethod: transcoding ? 'Transcode' : 'DirectPlay',
      ...extra,
    };
  }

  /**
   * `extra` carries what remote controllers display: `MediaSourceId`,
   * `VolumeLevel`, `IsMuted`, `RepeatMode`, `PlaybackOrder`, `NowPlayingQueue`.
   */
  async reportPlaybackStart(
    itemId: string,
    opts: { transcoding?: boolean; extra?: PlaybackExtra } = {},
  ): Promise<void> {
    await this.request('POST', '/Sessions/Playing', {
      body: this.playbackInfo(itemId, 0, false, opts.transcoding ?? false, opts.extra ?? {}),
    });
  }

  async reportPlaybackProgress(
    itemId: string,
    positionMs: number,
    opts: { paused?: boolean; transcoding?: boolean; extra?: PlaybackExtra } = {},
  ): Promise<void> {
    await this.request('POST', '/Sessions/Playing/Progress', {
      body: this.playbackInfo(
        itemId,
        positionMs,
        opts.paused ?? false,
        opts.transcoding ?? false,
        opts.extra ?? {},
      ),
    });
  }

  async reportPlaybackStopped(
    itemId: string,
    positionMs: number,
    opts: { transcoding?: boolean; extra?: PlaybackExtra } = {},
  ): Promise<void> {
    await this.request('POST', '/Sessions/Playing/Stopped', {
      body: this.playbackInfo(itemId, positionMs, false, opts.transcoding ?? false, opts.extra ?? {}),
    });
  }
}
