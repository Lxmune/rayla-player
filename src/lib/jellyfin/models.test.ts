import { describe, expect, it } from 'vitest';
import type { SignalPath } from '../ipc';
import { trackJson, track } from '../test-support';
import {
  activeLyricIndex,
  artistLine,
  audioStream,
  baseItemToJson,
  formatBytes,
  formatLine,
  formatSampleRate,
  imageItemId,
  itemDurationMs,
  pageHasMore,
  parseBaseItem,
  parseItemsPage,
  parseLyrics,
  lyricsIsEmpty,
  techInfoRows,
  transcodeLabel,
  toTrackMeta,
  willTranscode,
  type LyricLine,
} from './models';

describe('parseBaseItem', () => {
  it('is defensive about missing and wrongly typed fields', () => {
    const item = parseBaseItem({
      Id: 5,
      Artists: ['a', 3, null],
      ImageTags: 'nope',
      UserData: [],
      DateCreated: 'not a date',
      MediaSources: ['x', { Id: 's' }],
      RunTimeTicks: '12',
    });
    expect(item.id).toBe('');
    expect(item.artists).toEqual(['a']);
    expect(item.primaryImageTag).toBeNull();
    expect(item.isFavorite).toBe(false);
    expect(item.dateCreated).toBeNull();
    expect(item.mediaSources).toHaveLength(1);
    expect(item.runTimeTicks).toBeNull();
    expect(parseBaseItem(null).name).toBe('');
  });

  it('keeps ids, numbering and stream fields', () => {
    const item = track('t1', { gain: -6.5 });
    expect(item.albumId).toBe('al1');
    expect(item.normalizationGain).toBe(-6.5);
    expect(itemDurationMs(item)).toBe(180000);
    const s = audioStream(item);
    expect([s?.codec, s?.sampleRate, s?.bitDepth, s?.bitRate, s?.channels]).toEqual([
      'flac',
      96000,
      24,
      2000000,
      2,
    ]);
  });

  it('round-trips through baseItemToJson', () => {
    const item = parseBaseItem({
      Id: 'x',
      Name: 'X',
      Type: 'Audio',
      AlbumId: 'al',
      NormalizationGain: -4.5,
      DateCreated: '2026-01-02T03:04:05Z',
      UserData: { IsFavorite: true, PlayCount: 7, LastPlayedDate: '2026-11-01T10:00:00Z' },
      ImageTags: { Primary: 'tag' },
      GenreItems: [{ Id: 'g1', Name: 'Metal' }],
      Tags: ['vocaloid'],
      MediaSources: [
        {
          Id: 's',
          Container: 'flac',
          Size: 1234,
          Path: '/music/x.flac',
          MediaStreams: [{ Type: 'Audio', Codec: 'flac', ChannelLayout: 'stereo' }],
        },
      ],
    });
    const again = parseBaseItem(baseItemToJson(item));
    expect(again).toEqual(item);
    expect(again.mediaSources[0]?.size).toBe(1234);
    expect(audioStream(again)?.channelLayout).toBe('stereo');
  });

  it('pages report more', () => {
    const page = parseItemsPage({ TotalRecordCount: 5, StartIndex: 2, Items: [{ Id: 'a' }, { Id: 'b' }] });
    expect(pageHasMore(page)).toBe(true);
    expect(pageHasMore(parseItemsPage({ Items: [{ Id: 'a' }] }))).toBe(false);
  });
});

describe('item helpers', () => {
  it('imageItemId falls back to the album', () => {
    expect(imageItemId(parseBaseItem({ Id: 't', AlbumId: 'al' }))).toBe('al');
    expect(imageItemId(parseBaseItem({ Id: 't', AlbumId: 'al', ImageTags: { Primary: 'x' } }))).toBe('t');
    expect(imageItemId(parseBaseItem({ Id: 't' }))).toBe('t');
  });

  it('artistLine prefers track artists, then album artist(s)', () => {
    expect(artistLine(parseBaseItem({ Artists: ['A', 'B'], AlbumArtist: 'C' }))).toBe('A, B');
    expect(artistLine(parseBaseItem({ AlbumArtist: 'C' }))).toBe('C');
    expect(artistLine(parseBaseItem({ AlbumArtists: [{ Id: '1', Name: 'D' }] }))).toBe('D');
  });

  it('toTrackMeta summarises a track for integrations', () => {
    const meta = toTrackMeta(
      parseBaseItem({ ...trackJson('t', 'Song', { index: 3 }), ProductionYear: 1999 }),
    );
    expect(meta).toEqual({
      id: 't',
      albumId: 'al1',
      imageItemId: 'al1',
      title: 'Song',
      artists: ['Artist'],
      album: 'Album',
      albumArtist: 'Artist',
      year: 1999,
      trackNumber: 3,
      durationMs: 180000,
      container: 'flac',
      codec: 'flac',
      sampleRate: 96000,
      bitDepth: 24,
      bitrate: 2000000,
    });
    expect(toTrackMeta(parseBaseItem({ Id: 'x', ImageTags: { Primary: 't' } })).imageItemId).toBe('x');
    expect(toTrackMeta(parseBaseItem({ Id: 'x' })).imageItemId).toBeNull();
  });
});

describe('lyrics', () => {
  const line = (s: number, text: string): LyricLine => ({ startMs: Math.round(s * 1000), text });
  const lines = [line(1, 'a'), line(5, 'b'), line(9.5, 'c')];

  it('activeLyricIndex is -1 before the first line and with no lines', () => {
    expect(activeLyricIndex(lines, 0)).toBe(-1);
    expect(activeLyricIndex(lines, 999)).toBe(-1);
    expect(activeLyricIndex([], 3000)).toBe(-1);
  });

  it('picks the last line started, inclusive of its start', () => {
    expect(activeLyricIndex(lines, 1000)).toBe(0);
    expect(activeLyricIndex(lines, 4999)).toBe(0);
    expect(activeLyricIndex(lines, 5000)).toBe(1);
    expect(activeLyricIndex(lines, 600000)).toBe(2);
  });

  it('ignores lines without a start', () => {
    const mixed = [line(1, 'a'), { startMs: null, text: 'plain' }, line(3, 'b')];
    expect(activeLyricIndex(mixed, 2000)).toBe(0);
    expect(activeLyricIndex(mixed, 4000)).toBe(2);
  });

  it('ticks (100 ns) become milliseconds; IsSynced is honoured', () => {
    const l = parseLyrics({
      Metadata: { IsSynced: true },
      Lyrics: [
        { Text: 'Hello', Start: 12000000 },
        { Text: 'World', Start: 50000000 },
      ],
    });
    expect(l.isSynced).toBe(true);
    expect(l.lines[0]?.startMs).toBe(1200);
    expect(l.lines[1]?.text).toBe('World');
  });

  it('unsynced lyrics have no starts; sync is inferred without metadata', () => {
    const l = parseLyrics({ Metadata: { IsSynced: false }, Lyrics: [{ Text: 'one' }, { Text: 'two' }] });
    expect(l.isSynced).toBe(false);
    expect(l.lines.every((e) => e.startMs === null)).toBe(true);
    expect(parseLyrics({ Lyrics: [{ Text: 'a', Start: 1 }] }).isSynced).toBe(true);
    expect(parseLyrics({ Lyrics: [{ Text: 'a', Start: 1 }, { Text: 'b' }] }).isSynced).toBe(false);
    expect(lyricsIsEmpty(parseLyrics({ Lyrics: [{ Text: '  ' }] }))).toBe(true);
  });
});

describe('willTranscode', () => {
  const item = (o: { bitrate?: number; container?: string }) =>
    parseBaseItem({
      Id: 'x',
      Type: 'Audio',
      MediaSources: [{ Id: 'x', Container: o.container, Bitrate: o.bitrate }],
    });

  it('no cap never transcodes', () => {
    expect(willTranscode(item({ bitrate: 9000000, container: 'flac' }), null)).toBe(false);
  });
  it('source above the cap transcodes, below does not', () => {
    expect(willTranscode(item({ bitrate: 1411000, container: 'flac' }), 320000)).toBe(true);
    expect(willTranscode(item({ bitrate: 256000, container: 'mp3' }), 320000)).toBe(false);
  });
  it('non direct-streamable containers and unknown bitrate transcode', () => {
    expect(willTranscode(item({ bitrate: 100000, container: 'dsf' }), 320000)).toBe(true);
    expect(willTranscode(item({ container: 'mp3' }), 320000)).toBe(true);
  });
  it('multi-name containers match any known one', () => {
    expect(willTranscode(item({ bitrate: 100000, container: 'mov,mp4,m4a,3gp' }), 320000)).toBe(false);
  });
});

describe('formatting and tech info', () => {
  it('formats bytes and sample rates', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(150 * 1024)).toBe('150 KB');
    expect(formatSampleRate(96000)).toBe('96 kHz');
    expect(formatSampleRate(44100)).toBe('44.1 kHz');
  });

  const path: SignalPath = {
    codec: 'flac',
    sourceSampleRate: 96000,
    sourceBitDepth: 24,
    channels: 2,
    stages: ['ReplayGain -6.2 dB'],
    deviceName: 'USB DAC',
    outputSampleRate: 96000,
    outputBitDepth: 24,
    exclusive: true,
    bitPerfect: false,
  };

  it('formatLine prefers the live path', () => {
    expect(formatLine(track('t'), null)).toBe('FLAC · 24-bit / 96 kHz');
    expect(formatLine(null, path)).toBe('FLAC · 24-bit / 96 kHz');
    expect(formatLine(null, null)).toBeNull();
  });

  const rows = (t = track('t'), o: Parameters<typeof techInfoRows>[1] = {}) =>
    Object.fromEntries(techInfoRows(t, o));

  it('reads container, codec and stream details from Jellyfin', () => {
    const item = parseBaseItem({
      ...trackJson('t', 'T', { gain: -6.25 }),
      MediaSources: [
        {
          Id: 't',
          Container: 'flac',
          Bitrate: 2000000,
          Size: 5 * 1024 * 1024,
          Path: '/music/t.flac',
          MediaStreams: [
            {
              Type: 'Audio',
              Codec: 'flac',
              SampleRate: 96000,
              BitDepth: 24,
              BitRate: 1900000,
              Channels: 2,
              ChannelLayout: 'stereo',
            },
          ],
        },
      ],
    });
    const r = rows(item);
    expect(r['Container']).toBe('FLAC');
    expect(r['Bitrate']).toBe('1900 kbps');
    expect(r['Sample rate']).toBe('96 kHz');
    expect(r['Bit depth']).toBe('24-bit');
    expect(r['Channels']).toBe('2 · stereo');
    expect(r['File size']).toBe('5.0 MB');
    expect(r['Path']).toBe('/music/t.flac');
    expect(r['Normalization gain']).toMatch(/^-6\./);
    expect(r['Source']).toBe('Original file');
    expect('Output device' in r).toBe(false);
  });

  it('says transcoded under a cap and downloaded when local', () => {
    expect(rows(track('t'), { maxBitrate: 192000 })['Source']).toContain('Transcoded');
    expect(rows(track('t'), { maxBitrate: 192000 })['Source']).toContain('192 kbps');
    expect(rows(track('t'), { maxBitrate: 192000, downloaded: true })['Source']).toBe('Downloaded file');
  });

  it('adds the live signal path and omits unknown rows', () => {
    const r = rows(track('t'), { path });
    expect(r['Output device']).toBe('USB DAC');
    expect(r['Output']).toBe('24-bit / 96 kHz · Exclusive');
    expect(r['Processing']).toBe('ReplayGain -6.2 dB');
    expect(r['Bit-perfect']).toBe('No');
    expect(Object.keys(rows(parseBaseItem({ Id: 'x', Type: 'Audio' })))).toEqual(['Source']);
  });
});

describe('transcodeLabel', () => {
  it('names the target format', () => {
    expect(transcodeLabel('flac', 1_411_000)).toBe('Transcoded by server to FLAC 16/48');
    expect(transcodeLabel('flac', 192_000)).toBe('Transcoded by server to AAC (cap 192 kbps)');
    expect(transcodeLabel('mp3', 128_000)).toBe('Transcoded by server to MP3 (cap 128 kbps)');
    expect(transcodeLabel(null, 128_000)).toBe('Transcoded by server (cap 128 kbps)');
  });
});
