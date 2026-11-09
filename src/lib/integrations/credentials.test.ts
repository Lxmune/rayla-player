import { describe, expect, it } from 'vitest';
import { memoryKv } from '../platform';
import {
  IntegrationCredentials,
  SECRET_KEYS,
  activeScrobblers,
  type CredentialValues,
  createScrobbleService,
} from './credentials.svelte';
import { ScrobbleError } from './scrobblers';
import { memorySecrets } from './secrets';
import { fakeFetch } from './test-helpers';

const noNet = fakeFetch(() => [200, '{}']).fn;

describe('IntegrationCredentials', () => {
  it('stores trimmed values under the documented keys; blank deletes', async () => {
    const s = memorySecrets();
    const c = new IntegrationCredentials(s, noNet);
    await c.setListenBrainzToken('  tok ');
    await c.setLastFmApp(' key ', 'sec');
    expect(s.values.get(SECRET_KEYS.lbToken)).toBe('tok');
    expect(s.values.get('scrobble.lastfm.apiKey')).toBe('key');
    expect(s.values.get('scrobble.lastfm.secret')).toBe('sec');
    expect(c.hasListenBrainz).toBe(true);
    expect(c.hasLastFmApp).toBe(true);
    expect(c.hasLastFmSession).toBe(false);
    await c.setListenBrainzToken('   ');
    expect(s.values.has(SECRET_KEYS.lbToken)).toBe(false);
    expect(c.hasListenBrainz).toBe(false);
  });

  it('load restores from the store', async () => {
    const s = memorySecrets();
    await s.set('scrobble.lastfm.session', 'SK');
    await s.set('scrobble.lastfm.user', 'ann');
    const c = new IntegrationCredentials(s, noNet);
    await c.load();
    expect(c.hasLastFmSession).toBe(true);
    expect(c.lastFmUser).toBe('ann');
  });

  it('Last.fm login stores session key and user, never the password', async () => {
    const s = memorySecrets();
    const f = fakeFetch(() => [200, '{"session":{"key":"SK"}}']);
    const c = new IntegrationCredentials(s, f.fn);
    await c.setLastFmApp('key', 'sec');
    await c.lastFmLogin(' ann ', 'hunter2');
    expect(c.lastFmSessionKey).toBe('SK');
    expect(c.lastFmUser).toBe('ann');
    expect(s.values.get(SECRET_KEYS.lfmSession)).toBe('SK');
    expect([...s.values.values()]).not.toContain('hunter2');
    expect(new URLSearchParams(f.requests[0]!.body).get('username')).toBe('ann');
    await c.lastFmLogout();
    expect(c.hasLastFmSession).toBe(false);
    expect(s.values.has(SECRET_KEYS.lfmUser)).toBe(false);
    expect(s.values.get(SECRET_KEYS.lfmKey)).toBe('key');
  });

  it('failed login throws and stores nothing', async () => {
    const s = memorySecrets();
    const f = fakeFetch(() => [403, '{"error":4,"message":"Invalid"}']);
    const c = new IntegrationCredentials(s, f.fn);
    await c.setLastFmApp('key', 'sec');
    await expect(c.lastFmLogin('a', 'b')).rejects.toBeInstanceOf(ScrobbleError);
    expect(c.hasLastFmSession).toBe(false);
  });
});

describe('activeScrobblers', () => {
  const creds: CredentialValues = {
    listenBrainzToken: 'tok',
    lastFmApiKey: 'k',
    lastFmSecret: 's',
    lastFmSessionKey: 'sk',
  };
  it('requires both the toggle and credentials', () => {
    const ids = (t: [boolean, boolean], c = creds) =>
      activeScrobblers({ scrobbleListenBrainz: t[0], scrobbleLastFm: t[1] }, c, noNet).map(
        (s) => s.id,
      );
    expect(ids([true, true])).toEqual(['listenbrainz', 'lastfm']);
    expect(ids([true, false])).toEqual(['listenbrainz']);
    expect(ids([false, true])).toEqual(['lastfm']);
    expect(ids([true, true], { ...creds, listenBrainzToken: null, lastFmSessionKey: null })).toEqual(
      [],
    );
    expect(ids([false, true], { ...creds, lastFmSecret: null })).toEqual([]);
  });
});

describe('createScrobbleService', () => {
  it('reads toggles lazily and flushes pending scrobbles', async () => {
    const f = fakeFetch(() => [200, '{}']);
    const toggles = { scrobbleListenBrainz: false, scrobbleLastFm: false };
    const svc = createScrobbleService({
      fetch: f.fn,
      kv: memoryKv(),
      toggles: () => toggles,
      credentials: {
        listenBrainzToken: 'tok',
        lastFmApiKey: null,
        lastFmSecret: null,
        lastFmSessionKey: null,
      },
    });
    svc.queue.add({
      service: 'listenbrainz',
      listenedAtMs: 5000,
      track: { title: 'T', artist: 'A', album: null, albumArtist: null, durationMs: null, trackNumber: null },
    });
    await svc.flushPending();
    expect(f.requests).toHaveLength(0);
    toggles.scrobbleListenBrainz = true;
    await svc.flushPending();
    expect(f.requests).toHaveLength(1);
    expect(svc.queue.load()).toEqual([]);
  });
});
