import { describe, expect, it } from 'vitest';
import {
  LastFmClient,
  LastFmScrobbler,
  ListenBrainzScrobbler,
  ScrobbleError,
  lastFmSignature,
  type ScrobbleTrack,
} from './scrobblers';
import { fakeFetch } from './test-helpers';

const track: ScrobbleTrack = {
  title: 'Teardrop',
  artist: 'Massive Attack',
  album: 'Mezzanine',
  albumArtist: 'Massive Attack',
  durationMs: 329_000,
  trackNumber: 3,
};

async function failure(p: Promise<unknown>): Promise<ScrobbleError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ScrobbleError);
    return e as ScrobbleError;
  }
  throw new Error('expected rejection');
}

it('Last.fm signature matches the documented algorithm', () => {
  expect(
    lastFmSignature(
      {
        method: 'auth.getMobileSession',
        username: 'user',
        password: 'pw',
        api_key: 'xxx',
        format: 'json',
      },
      'sec',
    ),
  ).toBe('56ceaa8af0c0600997bcdc0cd39468f2');
});

describe('ListenBrainz', () => {
  it('playing_now has no listened_at', async () => {
    const f = fakeFetch(() => [200, '{"status":"ok"}']);
    await new ListenBrainzScrobbler(f.fn, 'tok').nowPlaying(track);
    const r = f.requests[0]!;
    expect(r.url).toBe('https://api.listenbrainz.org/1/submit-listens');
    expect(r.headers.Authorization).toBe('Token tok');
    const body = JSON.parse(r.body);
    expect(body.listen_type).toBe('playing_now');
    expect(body.payload[0]).not.toHaveProperty('listened_at');
    const m = body.payload[0].track_metadata;
    expect(m.artist_name).toBe('Massive Attack');
    expect(m.track_name).toBe('Teardrop');
    expect(m.release_name).toBe('Mezzanine');
    expect(m.additional_info.duration_ms).toBe(329000);
  });

  it('single listen carries listened_at in seconds', async () => {
    const f = fakeFetch(() => [200, '{}']);
    await new ListenBrainzScrobbler(f.fn, 'tok').scrobble(track, 1_700_000_000_000);
    const body = JSON.parse(f.requests[0]!.body);
    expect(body.listen_type).toBe('single');
    expect(body.payload[0].listened_at).toBe(1_700_000_000);
  });

  it('classifies errors', async () => {
    const bad = fakeFetch(() => [401, '{"code":401}']);
    expect((await failure(new ListenBrainzScrobbler(bad.fn, 't').nowPlaying(track))).retryable).toBe(false);
    const down = fakeFetch(() => [503, '']);
    expect((await failure(new ListenBrainzScrobbler(down.fn, 't').nowPlaying(track))).retryable).toBe(true);
    const limited = fakeFetch(() => [429, '']);
    expect((await failure(new ListenBrainzScrobbler(limited.fn, 't').nowPlaying(track))).retryable).toBe(true);
    const offline = fakeFetch(() => new Error('boom'));
    expect((await failure(new ListenBrainzScrobbler(offline.fn, 't').nowPlaying(track))).retryable).toBe(true);
  });

  it('validate returns the user name or throws', async () => {
    const ok = fakeFetch(() => [200, '{"valid":true,"user_name":"ann"}']);
    expect(await new ListenBrainzScrobbler(ok.fn, 't').validate()).toBe('ann');
    expect(ok.requests[0]!.url).toBe('https://api.listenbrainz.org/1/validate-token');
    const bad = fakeFetch(() => [200, '{"valid":false,"message":"nope"}']);
    expect((await failure(new ListenBrainzScrobbler(bad.fn, 't').validate())).message).toBe('nope');
  });
});

describe('Last.fm', () => {
  const client = (f: ReturnType<typeof fakeFetch>) => new LastFmClient(f.fn, 'key', 'sec');
  const form = (body: string) => Object.fromEntries(new URLSearchParams(body));

  it('scrobble is a signed form post', async () => {
    const f = fakeFetch(() => [200, '{"scrobbles":{}}']);
    await new LastFmScrobbler(client(f), 'sk1').scrobble(track, 1_700_000_000_000);
    expect(f.requests[0]!.url).toBe('https://ws.audioscrobbler.com/2.0/');
    const p = form(f.requests[0]!.body);
    expect(p).toMatchObject({
      method: 'track.scrobble',
      api_key: 'key',
      sk: 'sk1',
      artist: 'Massive Attack',
      track: 'Teardrop',
      timestamp: '1700000000',
      duration: '329',
      format: 'json',
    });
    const { api_sig, ...signed } = p;
    expect(api_sig).toBe(lastFmSignature(signed, 'sec'));
  });

  it('updateNowPlaying has no timestamp', async () => {
    const f = fakeFetch(() => [200, '{"nowplaying":{}}']);
    await new LastFmScrobbler(client(f), 'sk1').nowPlaying(track);
    const p = form(f.requests[0]!.body);
    expect(p.method).toBe('track.updateNowPlaying');
    expect(p).not.toHaveProperty('timestamp');
  });

  it('getMobileSession returns the key; API errors are classified', async () => {
    const ok = fakeFetch(() => [200, '{"session":{"name":"ann","key":"SK","subscriber":0}}']);
    expect(await client(ok).getMobileSession('ann', 'pw')).toBe('SK');
    expect(form(ok.requests[0]!.body)).toMatchObject({
      method: 'auth.getMobileSession',
      username: 'ann',
      password: 'pw',
    });
    const bad = fakeFetch(() => [403, '{"error":4,"message":"Invalid auth"}']);
    expect((await failure(client(bad).getMobileSession('ann', 'x'))).retryable).toBe(false);
    const temp = fakeFetch(() => [500, '{"error":16,"message":"temp"}']);
    expect((await failure(client(temp).getMobileSession('ann', 'x'))).retryable).toBe(true);
    const http = fakeFetch(() => [502, '']);
    expect((await failure(client(http).call('x', {}))).retryable).toBe(true);
    const nokey = fakeFetch(() => [200, '{}']);
    await failure(client(nokey).getMobileSession('a', 'b'));
  });
});
