import type { HttpFetch, KeyValueStore } from '../platform';
import type { Secrets } from './secrets';
import { ScrobbleRetryQueue, ScrobbleTracker } from './scrobble';
import {
  LastFmClient,
  LastFmScrobbler,
  ListenBrainzScrobbler,
  type Scrobbler,
} from './scrobblers';

export const SECRET_KEYS = {
  lbToken: 'scrobble.listenbrainz.token',
  lfmKey: 'scrobble.lastfm.apiKey',
  lfmSecret: 'scrobble.lastfm.secret',
  lfmSession: 'scrobble.lastfm.session',
  lfmUser: 'scrobble.lastfm.user',
} as const;

const blank = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

/** Stored credentials (reactive). The Last.fm password is never kept, only the
 *  session key it yields. Call `load()` once at startup. */
export class IntegrationCredentials {
  listenBrainzToken = $state<string | null>(null);
  lastFmApiKey = $state<string | null>(null);
  lastFmSecret = $state<string | null>(null);
  lastFmSessionKey = $state<string | null>(null);
  lastFmUser = $state<string | null>(null);

  readonly hasListenBrainz = $derived(!!this.listenBrainzToken);
  readonly hasLastFmSession = $derived(!!this.lastFmSessionKey);
  readonly hasLastFmApp = $derived(!!this.lastFmApiKey && !!this.lastFmSecret);

  constructor(
    private readonly secrets: Secrets,
    private readonly fetchFn: HttpFetch,
  ) {}

  async load(): Promise<void> {
    const get = (k: string) => this.secrets.get(k).catch(() => null);
    this.listenBrainzToken = await get(SECRET_KEYS.lbToken);
    this.lastFmApiKey = await get(SECRET_KEYS.lfmKey);
    this.lastFmSecret = await get(SECRET_KEYS.lfmSecret);
    this.lastFmSessionKey = await get(SECRET_KEYS.lfmSession);
    this.lastFmUser = await get(SECRET_KEYS.lfmUser);
  }

  async setListenBrainzToken(token: string | null): Promise<void> {
    const t = blank(token);
    await this.secrets.set(SECRET_KEYS.lbToken, t);
    this.listenBrainzToken = t;
  }

  async setLastFmApp(apiKey: string | null, secret: string | null): Promise<void> {
    const k = blank(apiKey);
    const s = blank(secret);
    await this.secrets.set(SECRET_KEYS.lfmKey, k);
    await this.secrets.set(SECRET_KEYS.lfmSecret, s);
    this.lastFmApiKey = k;
    this.lastFmSecret = s;
  }

  /** `auth.getMobileSession`; throws ScrobbleError. Stores only the session key. */
  async lastFmLogin(username: string, password: string): Promise<void> {
    const user = username.trim();
    const client = new LastFmClient(this.fetchFn, this.lastFmApiKey ?? '', this.lastFmSecret ?? '');
    const key = await client.getMobileSession(user, password);
    await this.secrets.set(SECRET_KEYS.lfmSession, key);
    await this.secrets.set(SECRET_KEYS.lfmUser, user);
    this.lastFmSessionKey = key;
    this.lastFmUser = user;
  }

  async lastFmLogout(): Promise<void> {
    await this.secrets.set(SECRET_KEYS.lfmSession, null);
    await this.secrets.set(SECRET_KEYS.lfmUser, null);
    this.lastFmSessionKey = null;
    this.lastFmUser = null;
  }
}

export interface ScrobbleToggles {
  scrobbleListenBrainz: boolean;
  scrobbleLastFm: boolean;
}

/** Plain credential values (an `IntegrationCredentials` satisfies this). */
export interface CredentialValues {
  listenBrainzToken: string | null;
  lastFmApiKey: string | null;
  lastFmSecret: string | null;
  lastFmSessionKey: string | null;
}

/** Services that are both enabled in settings and have credentials. */
export function activeScrobblers(
  toggles: ScrobbleToggles,
  creds: CredentialValues,
  fetchFn: HttpFetch,
): Scrobbler[] {
  const out: Scrobbler[] = [];
  if (toggles.scrobbleListenBrainz && creds.listenBrainzToken) {
    out.push(new ListenBrainzScrobbler(fetchFn, creds.listenBrainzToken));
  }
  if (
    toggles.scrobbleLastFm &&
    creds.lastFmSessionKey &&
    creds.lastFmApiKey &&
    creds.lastFmSecret
  ) {
    out.push(
      new LastFmScrobbler(
        new LastFmClient(fetchFn, creds.lastFmApiKey, creds.lastFmSecret),
        creds.lastFmSessionKey,
      ),
    );
  }
  return out;
}

export interface ScrobbleServiceOptions {
  fetch: HttpFetch;
  kv: KeyValueStore;
  credentials: CredentialValues;
  /** Read lazily on each use so settings changes apply immediately. */
  toggles: () => ScrobbleToggles;
  clock?: () => number;
}

/** Wires tracker + retry queue to the live settings/credentials. */
export function createScrobbleService(o: ScrobbleServiceOptions): {
  tracker: ScrobbleTracker;
  queue: ScrobbleRetryQueue;
  scrobblers: () => Scrobbler[];
  /** Flush scrobbles that failed in an earlier session; call at startup. */
  flushPending: () => Promise<void>;
} {
  const queue = new ScrobbleRetryQueue(o.kv);
  const scrobblers = () => activeScrobblers(o.toggles(), o.credentials, o.fetch);
  const tracker = new ScrobbleTracker({ scrobblers, queue, clock: o.clock });
  return { tracker, queue, scrobblers, flushPending: () => queue.flush(scrobblers()) };
}
