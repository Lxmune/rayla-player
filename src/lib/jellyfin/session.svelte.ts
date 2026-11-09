// Multi-server sessions. Non-secret profile data lives in the KeyValueStore,
// access tokens only in the secrets store (OS keychain in production).

import type { HttpFetch, KeyValueStore } from '../platform';
import { JellyfinClient } from './client';
import { isObject } from './models';

/** OS-keychain-like store; `set(key, null)` deletes. */
export interface Secrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string | null): Promise<void>;
}

/** A saved server + user pair. The token lives in secrets, not in the KeyValueStore. */
export interface ServerProfile {
  id: string;
  serverUrl: string;
  userId: string;
  userName: string;
  /** Null when the keychain had none (the profile is listed but not usable). */
  token: string | null;
}

export const PROFILES_KEY = 'jellyfin.profiles';
export const ACTIVE_KEY = 'jellyfin.active';
export const DEVICE_ID_KEY = 'jellyfin.deviceId';
export const tokenKey = (profileId: string) => `jellyfin.token.${profileId}`;

export function profileHost(p: Pick<ServerProfile, 'serverUrl'>): string {
  try {
    return new URL(p.serverUrl).host || p.serverUrl;
  } catch {
    return p.serverUrl;
  }
}

function randomDeviceId(): string {
  const bytes = new Uint8Array(16);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SessionStoreDeps {
  kv: KeyValueStore;
  secrets: Secrets;
  fetch: HttpFetch;
  /** Shown in the Jellyfin dashboard. Default "Desktop". */
  deviceName?: string;
  /** Test seam for the generated device id. */
  generateDeviceId?: () => string;
}

export class SessionStore {
  /** Stable per-install id, generated once and persisted. */
  deviceId = $state('');
  /** All saved profiles (replaced, never mutated). */
  profiles = $state.raw<ServerProfile[]>([]);
  activeId = $state<string | null>(null);
  /** True once `load()` finished. */
  loaded = $state(false);

  /** The active profile, or null when signed out (or its token is missing). */
  active = $derived.by(() => {
    for (const p of this.profiles) if (p.id === this.activeId && p.token !== null) return p;
    return null;
  });

  /**
   * Client for the active profile, or null when signed out. Identity is stable
   * until the active profile changes (saving another profile does not replace it).
   */
  client = $derived.by(() => {
    const p = this.active;
    if (!p) return null;
    return this.makeClient({ baseUrl: p.serverUrl, token: p.token, userId: p.userId });
  });

  private readonly deps: SessionStoreDeps;
  private readonly before = new Set<() => void | Promise<void>>();
  private readonly after = new Set<(active: ServerProfile | null) => void>();

  constructor(deps: SessionStoreDeps) {
    this.deps = deps;
  }

  private makeClient(o: { baseUrl: string; token?: string | null; userId?: string | null }) {
    return new JellyfinClient({
      ...o,
      deviceId: this.deviceId,
      deviceName: this.deps.deviceName ?? 'Desktop',
      fetch: this.deps.fetch,
    });
  }

  /**
   * Runs (and is awaited) before the active profile changes through login,
   * switchTo or remove: the place to stop playback / the remote target that
   * belong to the old client.
   */
  beforeActiveChange(listener: () => void | Promise<void>): () => void {
    this.before.add(listener);
    return () => this.before.delete(listener);
  }

  /** Runs after the active profile changed (including to null). */
  onActiveChange(listener: (active: ServerProfile | null) => void): () => void {
    this.after.add(listener);
    return () => this.after.delete(listener);
  }

  /** Reads device id, profiles and tokens. Never throws. */
  async load(): Promise<void> {
    const { kv, secrets } = this.deps;
    let deviceId = kv.get(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId = (this.deps.generateDeviceId ?? randomDeviceId)();
      kv.set(DEVICE_ID_KEY, deviceId);
    }
    this.deviceId = deviceId;

    const profiles: ServerProfile[] = [];
    const raw = kv.get(PROFILES_KEY);
    if (raw) {
      let parsed: unknown = [];
      try {
        parsed = JSON.parse(raw);
      } catch {
        // corrupt: no profiles
      }
      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          if (!isObject(e)) continue;
          const { id, serverUrl, userId, userName } = e;
          if (
            typeof id !== 'string' ||
            typeof serverUrl !== 'string' ||
            typeof userId !== 'string' ||
            typeof userName !== 'string'
          )
            continue;
          let token: string | null = null;
          try {
            token = await secrets.get(tokenKey(id));
          } catch {
            // keychain unavailable: profile without token
          }
          profiles.push({ id, serverUrl, userId, userName, token: token || null });
        }
      }
    }
    this.profiles = profiles;
    this.activeId = kv.get(ACTIVE_KEY);
    this.loaded = true;
    this.notifyAfter();
  }

  private async runBefore(): Promise<void> {
    for (const l of [...this.before]) {
      try {
        await l();
      } catch {
        // a failing hook must not block sign-in/out
      }
    }
  }

  private notifyAfter(): void {
    const active = this.active;
    for (const l of [...this.after]) l(active);
  }

  private persist(): void {
    const { kv } = this.deps;
    kv.set(
      PROFILES_KEY,
      JSON.stringify(
        this.profiles.map(({ id, serverUrl, userId, userName }) => ({
          id,
          serverUrl,
          userId,
          userName,
        })),
      ),
    );
    kv.set(ACTIVE_KEY, this.activeId);
  }

  private async writeToken(profileId: string, token: string | null): Promise<void> {
    try {
      await this.deps.secrets.set(tokenKey(profileId), token);
    } catch {
      // The session then only lasts until the app exits.
    }
  }

  /**
   * Authenticates and saves (or refreshes) the matching profile, then makes it
   * active. Throws a JellyfinError on failure (see `describeError`).
   */
  async login(serverUrl: string, username: string, password: string): Promise<ServerProfile> {
    const probe = this.makeClient({ baseUrl: serverUrl });
    const auth = await probe.authenticate(username, password);
    const id = `${auth.serverId}:${auth.userId}`;
    const profile: ServerProfile = {
      id,
      serverUrl: probe.baseUrl,
      userId: auth.userId,
      userName: auth.userName === '' ? username : auth.userName,
      token: auth.accessToken,
    };
    await this.runBefore();
    this.profiles = [...this.profiles.filter((p) => p.id !== id), profile];
    this.activeId = id;
    await this.writeToken(id, auth.accessToken);
    this.persist();
    this.notifyAfter();
    return profile;
  }

  async switchTo(profileId: string): Promise<void> {
    if (!this.profiles.some((p) => p.id === profileId)) return;
    await this.runBefore();
    this.activeId = profileId;
    this.persist();
    this.notifyAfter();
  }

  /** Forgets a profile and its token. */
  async remove(profileId: string): Promise<void> {
    const wasActive = this.activeId === profileId;
    if (wasActive) await this.runBefore();
    this.profiles = this.profiles.filter((p) => p.id !== profileId);
    if (wasActive) this.activeId = null;
    await this.writeToken(profileId, null);
    this.persist();
    if (wasActive) this.notifyAfter();
  }

  /** Signs out the active profile (forgets it and its token). */
  async signOut(): Promise<void> {
    if (this.activeId !== null) await this.remove(this.activeId);
  }
}
