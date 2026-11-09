import { md5 } from 'js-md5';
import type { HttpFetch } from '../platform';

/** What a scrobbling service needs to know about a track. */
export interface ScrobbleTrack {
  title: string;
  artist: string;
  album: string | null;
  albumArtist: string | null;
  durationMs: number | null;
  trackNumber: number | null;
}

export class ScrobbleError extends Error {
  /** True for network and server-side failures worth retrying later. */
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'ScrobbleError';
    this.retryable = retryable;
  }
}

export interface Scrobbler {
  /** Stable id, used as the retry-queue key. */
  readonly id: string;
  nowPlaying(track: ScrobbleTrack): Promise<void>;
  /** `listenedAtMs`: unix epoch milliseconds when the listen started. */
  scrobble(track: ScrobbleTrack, listenedAtMs: number): Promise<void>;
}

type Json = Record<string, unknown>;

function parseObject(text: string): Json {
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
  } catch {
    return {};
  }
}

const retryableStatus = (s: number) => s >= 500 || s === 429;

/** Performs the request; network failures become retryable ScrobbleErrors. */
async function send(
  fetchFn: HttpFetch,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: Json }> {
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    throw new ScrobbleError(`Network error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* unreadable body: treated as empty */
  }
  return { status: res.status, body: parseObject(text) };
}

// ------------------------------------------------------------------ ListenBrainz

export class ListenBrainzScrobbler implements Scrobbler {
  readonly id = 'listenbrainz';
  constructor(
    private readonly fetchFn: HttpFetch,
    private readonly token: string,
    private readonly baseUrl = 'https://api.listenbrainz.org',
  ) {}

  private metadata(t: ScrobbleTrack): Json {
    const info: Json = { media_player: 'Rayla', submission_client: 'Rayla' };
    if (t.durationMs !== null) info.duration_ms = t.durationMs;
    if (t.trackNumber !== null) info.tracknumber = t.trackNumber;
    const m: Json = { artist_name: t.artist, track_name: t.title, additional_info: info };
    if (t.album !== null) m.release_name = t.album;
    return m;
  }

  private async submit(type: 'playing_now' | 'single', t: ScrobbleTrack, listenedAtMs?: number) {
    const entry: Json = {};
    if (listenedAtMs !== undefined) entry.listened_at = Math.floor(listenedAtMs / 1000);
    entry.track_metadata = this.metadata(t);
    const { status } = await send(this.fetchFn, `${this.baseUrl}/1/submit-listens`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ listen_type: type, payload: [entry] }),
    });
    if (status !== 200) {
      throw new ScrobbleError(`ListenBrainz HTTP ${status}`, retryableStatus(status));
    }
  }

  nowPlaying(track: ScrobbleTrack) {
    return this.submit('playing_now', track);
  }

  scrobble(track: ScrobbleTrack, listenedAtMs: number) {
    return this.submit('single', track, listenedAtMs);
  }

  /** Returns the user name when the token is valid, otherwise throws. */
  async validate(): Promise<string> {
    const { body } = await send(this.fetchFn, `${this.baseUrl}/1/validate-token`, {
      method: 'GET',
      headers: { Authorization: `Token ${this.token}` },
    });
    if (body.valid === true) return typeof body.user_name === 'string' ? body.user_name : '';
    throw new ScrobbleError(typeof body.message === 'string' ? body.message : 'Invalid token');
  }
}

// ---------------------------------------------------------------------- Last.fm

/** `api_sig`: params sorted by name (without `format`/`callback`), `name`+`value`
 *  concatenated, shared secret appended, md5 lowercase hex. */
export function lastFmSignature(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort();
  let base = '';
  for (const k of keys) base += k + params[k];
  return md5(base + secret);
}

/** Last.fm client. Login uses `auth.getMobileSession` (username + password); only the
 *  session key is stored, the password never is. */
export class LastFmClient {
  constructor(
    private readonly fetchFn: HttpFetch,
    private readonly apiKey: string,
    private readonly secret: string,
    private readonly baseUrl = 'https://ws.audioscrobbler.com/2.0/',
  ) {}

  /** Signs and POSTs a method call. Throws ScrobbleError on API errors. */
  async call(method: string, params: Record<string, string>): Promise<Json> {
    const all: Record<string, string> = { ...params, method, api_key: this.apiKey };
    all.api_sig = lastFmSignature(all, this.secret);
    all.format = 'json';
    const { status, body } = await send(this.fetchFn, this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(all).toString(),
    });
    if (body.error !== undefined && body.error !== null) {
      const code = Number(body.error);
      throw new ScrobbleError(
        `Last.fm error ${code}: ${String(body.message)}`,
        // 11 service offline, 16 temporary error, 29 rate limit.
        code === 11 || code === 16 || code === 29,
      );
    }
    if (status !== 200) throw new ScrobbleError(`Last.fm HTTP ${status}`, retryableStatus(status));
    return body;
  }

  async getMobileSession(username: string, password: string): Promise<string> {
    const body = await this.call('auth.getMobileSession', { username, password });
    const session = body.session;
    const key =
      session !== null && typeof session === 'object' ? (session as Json).key : undefined;
    if (typeof key !== 'string') throw new ScrobbleError('No session key returned');
    return key;
  }
}

export class LastFmScrobbler implements Scrobbler {
  readonly id = 'lastfm';
  constructor(
    private readonly client: LastFmClient,
    private readonly sessionKey: string,
  ) {}

  private params(t: ScrobbleTrack): Record<string, string> {
    const p: Record<string, string> = { artist: t.artist, track: t.title };
    if (t.album !== null) p.album = t.album;
    if (t.albumArtist !== null) p.albumArtist = t.albumArtist;
    if (t.durationMs !== null) p.duration = String(Math.floor(t.durationMs / 1000));
    if (t.trackNumber !== null) p.trackNumber = String(t.trackNumber);
    p.sk = this.sessionKey;
    return p;
  }

  async nowPlaying(track: ScrobbleTrack) {
    await this.client.call('track.updateNowPlaying', this.params(track));
  }

  async scrobble(track: ScrobbleTrack, listenedAtMs: number) {
    await this.client.call('track.scrobble', {
      ...this.params(track),
      timestamp: String(Math.floor(listenedAtMs / 1000)),
    });
  }
}
