import { describe, expect, it } from 'vitest';
import { memoryKv } from '../platform';
import { FakeHttp, FakeStatus, memorySecrets } from '../test-support';
import { JellyfinError } from './client';
import { FavoritesStore } from './favorites.svelte';
import {
  ACTIVE_KEY,
  DEVICE_ID_KEY,
  PROFILES_KEY,
  SessionStore,
  profileHost,
  tokenKey,
} from './session.svelte';
import { parseBaseItem } from './models';

function auth(userId: string, serverId = 'srv', name = 'Ann') {
  return { AccessToken: `tok-${userId}`, ServerId: serverId, User: { Id: userId, Name: name } };
}

function make(opts: { routes?: Record<string, unknown>; kv?: ReturnType<typeof memoryKv> } = {}) {
  const kv = opts.kv ?? memoryKv();
  const secrets = memorySecrets();
  const http = new FakeHttp({ 'POST /Users/AuthenticateByName': auth('u1'), ...opts.routes });
  let n = 0;
  const store = new SessionStore({
    kv,
    secrets,
    fetch: http.fetch,
    deviceName: 'Test',
    generateDeviceId: () => `device-${++n}`,
  });
  return { kv, secrets, http, store };
}

describe('SessionStore', () => {
  it('generates the device id once and persists it', async () => {
    const { store, kv } = make();
    await store.load();
    expect(store.deviceId).toBe('device-1');
    expect(kv.get(DEVICE_ID_KEY)).toBe('device-1');
    const again = make({ kv });
    await again.store.load();
    expect(again.store.deviceId).toBe('device-1');
  });

  it('the default device id is 32 hex characters', async () => {
    const store = new SessionStore({ kv: memoryKv(), secrets: memorySecrets(), fetch: new FakeHttp().fetch });
    await store.load();
    expect(store.deviceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('login saves the profile, keeps the token only in secrets, and activates it', async () => {
    const { store, kv, secrets, http } = make();
    await store.load();
    const profile = await store.login(' jf.test:8096/ ', 'ann', 'pw');
    expect(profile).toMatchObject({ id: 'srv:u1', serverUrl: 'http://jf.test:8096', userName: 'Ann' });
    expect(store.activeId).toBe('srv:u1');
    expect(store.active?.token).toBe('tok-u1');
    expect(store.client?.token).toBe('tok-u1');
    expect(store.client?.baseUrl).toBe('http://jf.test:8096');
    expect(store.client?.deviceId).toBe('device-1');
    expect(secrets.store.get(tokenKey('srv:u1'))).toBe('tok-u1');
    expect(kv.get(PROFILES_KEY)).not.toContain('tok-u1');
    expect(kv.get(PROFILES_KEY)).not.toContain('token');
    expect(kv.get(ACTIVE_KEY)).toBe('srv:u1');
    expect(http.requests[0]?.headers['authorization']).toContain('DeviceId="device-1"');
  });

  it('restores profiles and tokens on the next start', async () => {
    const a = make();
    await a.store.load();
    await a.store.login('https://jf.test', 'ann', 'pw');
    const b = new SessionStore({ kv: a.kv, secrets: a.secrets, fetch: a.http.fetch });
    await b.load();
    expect(b.loaded).toBe(true);
    expect(b.profiles).toHaveLength(1);
    expect(b.active?.token).toBe('tok-u1');
    expect(b.client).not.toBeNull();
  });

  it('a profile whose token is missing is listed but not active', async () => {
    const a = make();
    await a.store.load();
    await a.store.login('https://jf.test', 'ann', 'pw');
    await a.secrets.set(tokenKey('srv:u1'), null);
    const b = new SessionStore({ kv: a.kv, secrets: a.secrets, fetch: a.http.fetch });
    await b.load();
    expect(b.profiles).toHaveLength(1);
    expect(b.active).toBeNull();
    expect(b.client).toBeNull();
  });

  it('a throwing keychain or corrupt profile list does not break load', async () => {
    const kv = memoryKv();
    kv.set(PROFILES_KEY, JSON.stringify([{ id: 'x', serverUrl: 'http://a', userId: 'u', userName: 'n' }, 7]));
    const store = new SessionStore({
      kv,
      secrets: { get: async () => { throw new Error('locked'); }, set: async () => {} },
      fetch: new FakeHttp().fetch,
    });
    await store.load();
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0]?.token).toBeNull();
    kv.set(PROFILES_KEY, '{nope');
    await store.load();
    expect(store.profiles).toEqual([]);
  });

  it('supports several servers: switch, relogin refreshes, remove forgets', async () => {
    const { store, http, secrets } = make();
    await store.load();
    await store.login('https://one.test', 'ann', 'pw');
    http.routes['POST /Users/AuthenticateByName'] = auth('u2', 'srv2', 'Bob');
    await store.login('https://two.test', 'bob', 'pw');
    expect(store.profiles.map((p) => p.id)).toEqual(['srv:u1', 'srv2:u2']);
    expect(store.activeId).toBe('srv2:u2');

    await store.switchTo('srv:u1');
    expect(store.client?.baseUrl).toBe('https://one.test');
    const clientBefore = store.client;
    expect(store.client).toBe(clientBefore); // stable identity

    http.routes['POST /Users/AuthenticateByName'] = { ...auth('u1'), AccessToken: 'fresh' };
    await store.login('https://one.test', 'ann', 'pw');
    expect(store.profiles).toHaveLength(2);
    expect(store.active?.token).toBe('fresh');

    await store.switchTo('nope'); // unknown id ignored
    expect(store.activeId).toBe('srv:u1');

    await store.remove('srv2:u2');
    expect(store.profiles.map((p) => p.id)).toEqual(['srv:u1']);
    expect(secrets.store.has(tokenKey('srv2:u2'))).toBe(false);
    expect(store.activeId).toBe('srv:u1');

    await store.signOut();
    expect(store.activeId).toBeNull();
    expect(store.client).toBeNull();
    expect(store.profiles).toEqual([]);
    expect(secrets.store.size).toBe(0);
  });

  it('the client keeps its identity when another profile is saved', async () => {
    const { store, http } = make();
    await store.load();
    await store.login('https://one.test', 'ann', 'pw');
    const c = store.client;
    http.routes['POST /Users/AuthenticateByName'] = auth('u2', 'srv2');
    await store.login('https://two.test', 'bob', 'pw');
    expect(store.client).not.toBe(c);
    await store.switchTo('srv:u1');
    const c1 = store.client;
    expect(c1?.baseUrl).toBe('https://one.test');
  });

  it('login failures throw and change nothing', async () => {
    const { store, kv } = make({ routes: { 'POST /Users/AuthenticateByName': new FakeStatus(401) } });
    await store.load();
    await expect(store.login('https://jf.test', 'ann', 'bad')).rejects.toBeInstanceOf(JellyfinError);
    expect(store.profiles).toEqual([]);
    expect(kv.get(PROFILES_KEY)).toBeNull();
  });

  it('runs before/after hooks around active-profile changes', async () => {
    const { store } = make();
    await store.load();
    const log: string[] = [];
    store.beforeActiveChange(async () => {
      log.push(`before:${store.activeId}`);
    });
    store.onActiveChange((p) => log.push(`after:${p?.id ?? null}`));
    await store.login('https://jf.test', 'ann', 'pw');
    await store.signOut();
    expect(log).toEqual(['before:null', 'after:srv:u1', 'before:srv:u1', 'after:null']);
  });

  it('profileHost extracts the host', () => {
    expect(profileHost({ serverUrl: 'https://jf.test:8920/x' })).toBe('jf.test:8920');
    expect(profileHost({ serverUrl: 'garbage' })).toBe('garbage');
  });
});

describe('FavoritesStore', () => {
  it('layers toggled flags over the server value', async () => {
    const { store, http } = make({
      routes: { 'POST /Users/u1/FavoriteItems/x': {}, 'DELETE /Users/u1/FavoriteItems/x': {} },
    });
    await store.load();
    await store.login('https://jf.test', 'ann', 'pw');
    const favs = new FavoritesStore(() => store.client);
    const item = parseBaseItem({ Id: 'x', UserData: { IsFavorite: false } });
    expect(favs.isFavorite(item)).toBe(false);
    expect(await favs.toggle(item)).toBe(true);
    expect(favs.isFavorite(item)).toBe(true);
    expect(await favs.toggle(item)).toBe(false);
    expect(http.requests.slice(-2).map((r) => r.method)).toEqual(['POST', 'DELETE']);
  });

  it('throws when signed out and keeps state when the request fails', async () => {
    const favs = new FavoritesStore(() => null);
    await expect(favs.toggle(parseBaseItem({ Id: 'x' }))).rejects.toThrow('Not signed in');
    const { store } = make({ routes: { 'POST /Users/u1/FavoriteItems/y': new FakeStatus(500) } });
    await store.load();
    await store.login('https://jf.test', 'ann', 'pw');
    const f2 = new FavoritesStore(() => store.client);
    const y = parseBaseItem({ Id: 'y' });
    await expect(f2.toggle(y)).rejects.toBeInstanceOf(JellyfinError);
    expect(f2.isFavorite(y)).toBe(false);
  });
});
