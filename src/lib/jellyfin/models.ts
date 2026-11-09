// Plain Jellyfin models with defensive JSON parsing (missing fields become
// null / defaults, never exceptions). Field names are camelCase versions of the
// Jellyfin DTO fields; `baseItemToJson` writes the original Jellyfin shape back
// so items can be stored (downloads index) and re-parsed.

import type { SignalPath } from '../ipc';
import type { TrackMeta } from '../track-meta';

type Json = Record<string, unknown>;

export function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
const float = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function list<T>(json: unknown, parse: (j: Json) => T): T[] {
  if (!Array.isArray(json)) return [];
  const out: T[] = [];
  for (const e of json) if (isObject(e)) out.push(parse(e));
  return out;
}

/** Drops undefined/null entries so omitted fields mirror the Dart `?x` map syntax. */
function compact(o: Record<string, unknown>): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

// ------------------------------------------------------------------- types

export interface NameId {
  id: string;
  name: string;
}

export interface MediaStream {
  /** Audio, Video, Subtitle, EmbeddedImage, Lyric */
  type: string;
  codec: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  bitRate: number | null;
  channels: number | null;
  channelLayout: string | null;
  profile: string | null;
}

export interface MediaSource {
  id: string;
  container: string | null;
  bitrate: number | null;
  size: number | null;
  path: string | null;
  mediaStreams: MediaStream[];
}

/** One Jellyfin `BaseItemDto`: artists, albums, tracks, playlists and genres alike. */
export interface BaseItem {
  id: string;
  name: string;
  /** MusicArtist, MusicAlbum, Audio, Playlist, MusicGenre */
  type: string;
  albumId: string | null;
  album: string | null;
  albumArtist: string | null;
  albumArtists: NameId[];
  artists: string[];
  artistItems: NameId[];
  indexNumber: number | null;
  parentIndexNumber: number | null;
  /** Jellyfin ticks (100 ns). */
  runTimeTicks: number | null;
  productionYear: number | null;
  childCount: number | null;
  normalizationGain: number | null;
  isFavorite: boolean;
  primaryImageTag: string | null;
  albumPrimaryImageTag: string | null;
  /** ISO-8601 string when it parsed as a date. */
  dateCreated: string | null;
  mediaSources: MediaSource[];
}

export interface ItemsPage {
  items: BaseItem[];
  totalRecordCount: number;
  startIndex: number;
}

export interface AuthResult {
  accessToken: string;
  userId: string;
  userName: string;
  serverId: string;
}

/** One lyric line. `startMs` is null for unsynced lyrics. */
export interface LyricLine {
  startMs: number | null;
  text: string;
}

export interface Lyrics {
  lines: LyricLine[];
  isSynced: boolean;
}

export interface SearchResults {
  artists: BaseItem[];
  albums: BaseItem[];
  tracks: BaseItem[];
}

// ----------------------------------------------------------------- parsing

export function parseNameId(j: Json): NameId {
  return { id: str(j.Id) ?? '', name: str(j.Name) ?? '' };
}

export function parseMediaStream(j: Json): MediaStream {
  return {
    type: str(j.Type) ?? '',
    codec: str(j.Codec),
    sampleRate: int(j.SampleRate),
    bitDepth: int(j.BitDepth),
    bitRate: int(j.BitRate),
    channels: int(j.Channels),
    channelLayout: str(j.ChannelLayout),
    profile: str(j.Profile),
  };
}

export function parseMediaSource(j: Json): MediaSource {
  return {
    id: str(j.Id) ?? '',
    container: str(j.Container),
    bitrate: int(j.Bitrate),
    size: int(j.Size),
    path: str(j.Path),
    mediaStreams: list(j.MediaStreams, parseMediaStream),
  };
}

/** Parses an item from unknown JSON; non-objects yield an empty item. */
export function parseBaseItem(json: unknown): BaseItem {
  const j: Json = isObject(json) ? json : {};
  const userData = isObject(j.UserData) ? j.UserData : null;
  const imageTags = isObject(j.ImageTags) ? j.ImageTags : null;
  const created = str(j.DateCreated);
  return {
    id: str(j.Id) ?? '',
    name: str(j.Name) ?? '',
    type: str(j.Type) ?? '',
    albumId: str(j.AlbumId),
    album: str(j.Album),
    albumArtist: str(j.AlbumArtist),
    albumArtists: list(j.AlbumArtists, parseNameId),
    artists: Array.isArray(j.Artists)
      ? j.Artists.filter((a): a is string => typeof a === 'string')
      : [],
    artistItems: list(j.ArtistItems, parseNameId),
    indexNumber: int(j.IndexNumber),
    parentIndexNumber: int(j.ParentIndexNumber),
    runTimeTicks: int(j.RunTimeTicks),
    productionYear: int(j.ProductionYear),
    childCount: int(j.ChildCount),
    normalizationGain: float(j.NormalizationGain),
    isFavorite: userData?.IsFavorite === true,
    primaryImageTag: str(imageTags?.Primary),
    albumPrimaryImageTag: str(j.AlbumPrimaryImageTag),
    dateCreated: created !== null && !Number.isNaN(Date.parse(created)) ? created : null,
    mediaSources: list(j.MediaSources, parseMediaSource),
  };
}

export function mediaStreamToJson(m: MediaStream): Json {
  return compact({
    Type: m.type,
    Codec: m.codec,
    SampleRate: m.sampleRate,
    BitDepth: m.bitDepth,
    BitRate: m.bitRate,
    Channels: m.channels,
    ChannelLayout: m.channelLayout,
    Profile: m.profile,
  });
}

export function mediaSourceToJson(m: MediaSource): Json {
  return {
    ...compact({
      Id: m.id,
      Container: m.container,
      Bitrate: m.bitrate,
      Size: m.size,
      Path: m.path,
    }),
    MediaStreams: m.mediaStreams.map(mediaStreamToJson),
  };
}

/** Re-parseable JSON (stored by the downloads index). */
export function baseItemToJson(i: BaseItem): Json {
  return {
    ...compact({
      Id: i.id,
      Name: i.name,
      Type: i.type,
      AlbumId: i.albumId,
      Album: i.album,
      AlbumArtist: i.albumArtist,
    }),
    AlbumArtists: i.albumArtists.map((a) => ({ Id: a.id, Name: a.name })),
    Artists: [...i.artists],
    ArtistItems: i.artistItems.map((a) => ({ Id: a.id, Name: a.name })),
    ...compact({
      IndexNumber: i.indexNumber,
      ParentIndexNumber: i.parentIndexNumber,
      RunTimeTicks: i.runTimeTicks,
      ProductionYear: i.productionYear,
      ChildCount: i.childCount,
      NormalizationGain: i.normalizationGain,
    }),
    UserData: { IsFavorite: i.isFavorite },
    ImageTags: compact({ Primary: i.primaryImageTag }),
    ...compact({ AlbumPrimaryImageTag: i.albumPrimaryImageTag, DateCreated: i.dateCreated }),
    MediaSources: i.mediaSources.map(mediaSourceToJson),
  };
}

export function parseItemsPage(json: unknown): ItemsPage {
  const j: Json = isObject(json) ? json : {};
  const items = list(j.Items, parseBaseItem);
  return {
    items,
    totalRecordCount: int(j.TotalRecordCount) ?? items.length,
    startIndex: int(j.StartIndex) ?? 0,
  };
}

export function pageHasMore(page: ItemsPage): boolean {
  return page.startIndex + page.items.length < page.totalRecordCount;
}

export function parseAuthResult(json: unknown): AuthResult {
  const j: Json = isObject(json) ? json : {};
  const user = isObject(j.User) ? j.User : {};
  return {
    accessToken: str(j.AccessToken) ?? '',
    userId: str(user.Id) ?? '',
    userName: str(user.Name) ?? '',
    serverId: str(j.ServerId) ?? '',
  };
}

// -------------------------------------------------------------- item helpers

export const withFavorite = (item: BaseItem, value: boolean): BaseItem => ({
  ...item,
  isFavorite: value,
});

export const firstMediaSource = (item: BaseItem): MediaSource | null =>
  item.mediaSources[0] ?? null;

/** Jellyfin ticks are 100 ns. */
export const itemDurationMs = (item: BaseItem): number =>
  Math.floor((item.runTimeTicks ?? 0) / 10000);

/** The first audio stream of the first media source that has one. */
export function audioStream(item: BaseItem): MediaStream | null {
  for (const source of item.mediaSources)
    for (const stream of source.mediaStreams) if (stream.type === 'Audio') return stream;
  return null;
}

/** Item whose Primary image represents this one: tracks without their own cover fall back to the album's. */
export const imageItemId = (item: BaseItem): string =>
  item.primaryImageTag === null && item.albumId !== null ? item.albumId : item.id;

/** Artist line for a track or album. */
export function artistLine(item: BaseItem): string {
  if (item.artists.length > 0) return item.artists.join(', ');
  return item.albumArtist ?? item.albumArtists.map((a) => a.name).join(', ');
}

/** Narrow view for integrations (scrobbling, Discord). */
export function toTrackMeta(item: BaseItem): TrackMeta {
  const source = firstMediaSource(item);
  const stream = audioStream(item);
  const artists =
    item.artists.length > 0
      ? [...item.artists]
      : item.albumArtist
        ? [item.albumArtist]
        : item.albumArtists.map((a) => a.name);
  const container = source?.container?.split(',')[0]?.trim();
  return {
    id: item.id,
    albumId: item.albumId,
    imageItemId: item.primaryImageTag !== null ? item.id : item.albumId,
    title: item.name,
    artists,
    album: item.album,
    albumArtist: item.albumArtist ?? item.albumArtists[0]?.name ?? null,
    year: item.productionYear,
    trackNumber: item.indexNumber,
    durationMs: itemDurationMs(item),
    container: container ? container : null,
    codec: stream?.codec ?? null,
    sampleRate: stream?.sampleRate ?? null,
    bitDepth: stream?.bitDepth ?? null,
    bitrate: stream?.bitRate ?? source?.bitrate ?? null,
  };
}

// ------------------------------------------------------------------- lyrics

export function parseLyricLine(j: Json): LyricLine {
  const ticks = int(j.Start);
  return { startMs: ticks === null ? null : Math.floor(ticks / 10000), text: str(j.Text) ?? '' };
}

/** `GET /Audio/{id}/Lyrics` (Jellyfin 10.9+). */
export function parseLyrics(json: unknown): Lyrics {
  const j: Json = isObject(json) ? json : {};
  const lines = list(j.Lyrics, parseLyricLine);
  const meta = isObject(j.Metadata) ? j.Metadata : null;
  const isSynced =
    typeof meta?.IsSynced === 'boolean'
      ? meta.IsSynced
      : lines.length > 0 && lines.every((l) => l.startMs !== null);
  return { lines, isSynced };
}

export const lyricsIsEmpty = (l: Lyrics): boolean => l.lines.every((x) => x.text.trim() === '');

/**
 * Index of the lyric line active at `positionMs`: the last line whose start is
 * at or before it, or -1 before the first line. Lines without a start never
 * become active; lines are assumed ordered by start.
 */
export function activeLyricIndex(lines: readonly LyricLine[], positionMs: number): number {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i]?.startMs;
    if (start === null || start === undefined) continue;
    if (start <= positionMs) active = i;
    else break;
  }
  return active;
}

// --------------------------------------------------------------- transcoding

/** Containers the universal endpoint is asked to direct-stream. */
export const DIRECT_STREAM_CONTAINERS = ['flac', 'mp3', 'aac', 'm4a', 'ogg', 'wav'] as const;

/**
 * Whether the server will transcode `item` under a bitrate `cap` (bits/s): the
 * source exceeds it, or its container is not direct-streamable. With the
 * source bitrate unknown a cap is assumed to transcode.
 */
export function willTranscode(item: BaseItem, cap: number | null): boolean {
  if (cap === null) return false;
  const source = firstMediaSource(item);
  const bitrate = source?.bitrate ?? audioStream(item)?.bitRate ?? null;
  if (bitrate === null || bitrate > cap) return true;
  const container = source?.container;
  if (container) {
    return !container
      .split(',')
      .some((c) => (DIRECT_STREAM_CONTAINERS as readonly string[]).includes(c));
  }
  return false;
}

// ----------------------------------------------------------------- formatting

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${bytes} B` : `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

export function formatSampleRate(hz: number): string {
  const k = hz / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
}

const kbps = (bps: number) => `${Math.round(bps / 1000)} kbps`;

/** e.g. "FLAC · 24-bit / 96 kHz". Prefers the live signal path, then Jellyfin's stream info. */
export function formatLine(track: BaseItem | null, path: SignalPath | null): string | null {
  let codec: string | null = null;
  let bits: number | null = null;
  let rate: number | null = null;
  const stream = track ? audioStream(track) : null;
  if (path) {
    codec = path.codec;
    bits = path.sourceBitDepth;
    rate = path.sourceSampleRate;
  } else if (stream) {
    codec = stream.codec;
    bits = stream.bitDepth;
    rate = stream.sampleRate;
  }
  const detail = [
    ...(bits !== null && bits > 0 ? [`${bits}-bit`] : []),
    ...(rate !== null && rate > 0 ? [formatSampleRate(rate)] : []),
  ].join(' / ');
  const parts = [...(codec ? [codec.toUpperCase()] : []), ...(detail ? [detail] : [])];
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * Label/value rows describing one track, from what Jellyfin reports plus, for
 * the playing track, the live signal path.
 */
export function techInfoRows(
  track: BaseItem,
  opts: { path?: SignalPath | null; maxBitrate?: number | null; downloaded?: boolean } = {},
): [string, string][] {
  const { path = null, maxBitrate = null, downloaded = false } = opts;
  const source = firstMediaSource(track);
  const stream = audioStream(track);
  const rows: [string, string][] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) rows.push([label, value]);
  };

  add('Container', source?.container?.split(',')[0]?.toUpperCase());
  add(
    'Codec',
    stream?.codec
      ? [stream.codec.toUpperCase(), ...(stream.profile ? [stream.profile] : [])].join(' · ')
      : null,
  );
  const bitrate = stream?.bitRate ?? source?.bitrate ?? null;
  add('Bitrate', bitrate !== null && bitrate > 0 ? kbps(bitrate) : null);
  const rate = stream?.sampleRate ?? null;
  add('Sample rate', rate !== null && rate > 0 ? formatSampleRate(rate) : null);
  const bits = stream?.bitDepth ?? null;
  add('Bit depth', bits !== null && bits > 0 ? `${bits}-bit` : null);
  add(
    'Channels',
    stream?.channels != null
      ? [`${stream.channels}`, ...(stream.channelLayout ? [stream.channelLayout] : [])].join(' · ')
      : null,
  );
  const size = source?.size ?? null;
  add('File size', size !== null && size > 0 ? formatBytes(size) : null);
  add('Path', source?.path);
  const gain = track.normalizationGain;
  add('Normalization gain', gain === null ? null : `${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`);
  add(
    'Source',
    downloaded
      ? 'Downloaded file'
      : willTranscode(track, maxBitrate)
        ? `Transcoded by server (cap ${kbps(maxBitrate ?? 0)})`
        : 'Original file',
  );
  if (path) {
    const out = [
      ...(path.outputBitDepth > 0 ? [`${path.outputBitDepth}-bit`] : []),
      ...(path.outputSampleRate > 0 ? [formatSampleRate(path.outputSampleRate)] : []),
    ].join(' / ');
    add('Output device', path.deviceName);
    add('Output', [out, path.exclusive ? 'Exclusive' : 'Shared'].filter((e) => e).join(' · '));
    add('Processing', path.stages.length === 0 ? 'None' : path.stages.join(', '));
    add('Bit-perfect', path.bitPerfect ? 'Yes' : 'No');
  }
  return rows;
}
