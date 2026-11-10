// Fakes shared by the unit tests of the core modules. Not imported by app code.

import type {
  DownloadProgress,
  DownloadRecord,
  DownloadRequest,
  DspConfig,
  EngineEvent,
  EventKind,
  OutputDevice,
  PlaybackState,
  TrackRequest,
} from './ipc';
import type { HttpFetch, Socket, SocketFactory } from './platform';
import { JellyfinClient } from './jellyfin/client';
import { parseBaseItem, type BaseItem } from './jellyfin/models';

export const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/** Lets queued promise continuations and zero-delay timers run. */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

// ------------------------------------------------------------------- HTTP

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export class FakeStatus {
  constructor(
    readonly status: number,
    readonly body: unknown = {},
  ) {}
}

/** Serves canned JSON by "METHOD /path" (404 when missing) and records requests. */
export class FakeHttp {
  readonly requests: RecordedRequest[] = [];
  /** When set, every request rejects with this (a network failure). */
  failWith: Error | null = null;
  constructor(public routes: Record<string, unknown> = {}) {}

  readonly fetch: HttpFetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    this.requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body,
    });
    if (this.failWith) throw this.failWith;
    const route = this.routes[`${method} ${url.pathname}`];
    if (route === undefined) return new Response('{}', { status: 404 });
    if (route instanceof FakeStatus) {
      return new Response(JSON.stringify(route.body), { status: route.status });
    }
    return new Response(typeof route === 'string' ? route : JSON.stringify(route), { status: 200 });
  };

  get paths(): string[] {
    return this.requests.map((r) => r.path);
  }
}

export function fakeClient(
  http: FakeHttp,
  opts: { token?: string | null } = {},
): JellyfinClient {
  return new JellyfinClient({
    baseUrl: 'https://jf.test',
    deviceId: 'dev123',
    deviceName: 'Test',
    token: opts.token === undefined ? 'tok' : opts.token,
    userId: 'u1',
    fetch: http.fetch,
  });
}

// ------------------------------------------------------------------ items

export function trackJson(
  id: string,
  name: string,
  o: { index?: number; disc?: number; gain?: number; album?: string; durationMs?: number } = {},
): Record<string, unknown> {
  return {
    Id: id,
    Name: name,
    Type: 'Audio',
    AlbumId: o.album ?? 'al1',
    Album: 'Album',
    AlbumArtist: 'Artist',
    Artists: ['Artist'],
    ...(o.index !== undefined ? { IndexNumber: o.index } : {}),
    ...(o.disc !== undefined ? { ParentIndexNumber: o.disc } : {}),
    RunTimeTicks: (o.durationMs ?? 180000) * 10000,
    ...(o.gain !== undefined ? { NormalizationGain: o.gain } : {}),
    MediaSources: [
      {
        Id: id,
        Container: 'flac',
        Bitrate: 2000000,
        MediaStreams: [
          {
            Type: 'Audio',
            Codec: 'flac',
            SampleRate: 96000,
            BitDepth: 24,
            BitRate: 2000000,
            Channels: 2,
          },
        ],
      },
    ],
  };
}

export function track(
  id: string,
  o: { album?: string | null; gain?: number; durationMs?: number } = {},
): BaseItem {
  return parseBaseItem(
    trackJson(id, `Track ${id}`, {
      index: 1,
      gain: o.gain,
      album: o.album ?? 'al1',
      durationMs: o.durationMs,
    }),
  );
}

// ----------------------------------------------------------------- engine

/** Records every engine call as a readable string and lets tests push events. */
export class FakeEngine {
  readonly calls: string[] = [];
  readonly loaded: TrackRequest[] = [];
  readonly nextRequests: (TrackRequest | null)[] = [];
  /** Every non-null request sent (load or setNext), oldest first. */
  readonly requests: TrackRequest[] = [];
  lastDsp: DspConfig | null = null;
  /** Makes setDsp / setOutput reject. */
  rejectSettings: string | null = null;
  private listeners = new Set<(e: EngineEvent) => void>();

  emit(e: EngineEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  /** Entry id of the latest request for track `id` (what the engine would echo). */
  private entryFor(id: string, entry?: string): string | null {
    if (entry !== undefined) return entry;
    return [...this.requests].reverse().find((r) => r.id === id)?.entryId ?? null;
  }

  private event(
    kind: EventKind,
    id: string | null,
    o: Partial<EngineEvent> = {},
  ): EngineEvent {
    return {
      kind,
      state: 'playing',
      trackId: id,
      entryId: null,
      positionMs: 0,
      durationMs: 0,
      signalPath: null,
      message: null,
      throughputBps: 0,
      cachedBytes: 0,
      totalBytes: 0,
      ...o,
    };
  }

  trackStarted(id: string, entry?: string) {
    this.emit(this.event('trackStarted', id, { entryId: this.entryFor(id, entry) }));
  }
  trackEnded(id: string, entry?: string) {
    this.emit(this.event('trackEnded', id, { entryId: this.entryFor(id, entry) }));
  }
  error(message: string, id?: string, entry?: string) {
    this.emit(
      this.event('error', id ?? null, { entryId: this.entryFor(id ?? '', entry), message }),
    );
  }
  position(id: string, ms: number, o: { dur?: number; entry?: string } = {}) {
    this.emit(
      this.event('position', id, {
        entryId: this.entryFor(id, o.entry),
        positionMs: ms,
        durationMs: o.dur ?? 200000,
      }),
    );
  }
  state(s: PlaybackState) {
    this.emit(this.event('stateChanged', null, { state: s }));
  }

  get lastNext(): TrackRequest | null {
    return this.nextRequests[this.nextRequests.length - 1] ?? null;
  }
  get lastNextId(): string | null {
    return this.lastNext?.id ?? null;
  }

  // ---- the Ipc surface the stores use
  readonly onEngineEvent = async (cb: (e: EngineEvent) => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  readonly listDevices = async (): Promise<OutputDevice[]> => [];
  readonly setOutput = async (deviceId: string | null, exclusive: boolean) => {
    this.calls.push(`setOutput(${deviceId},${exclusive})`);
    if (this.rejectSettings) throw this.rejectSettings;
  };
  readonly load = async (t: TrackRequest, startPlaying: boolean) => {
    this.calls.push(`load(${t.id},${startPlaying})`);
    this.loaded.push(t);
    this.requests.push(t);
  };
  readonly setNext = async (t: TrackRequest | null) => {
    this.calls.push(`setNext(${t?.id ?? null})`);
    this.nextRequests.push(t);
    if (t) this.requests.push(t);
  };
  /** Every prefetch list sent, oldest first (kept out of `calls`). */
  readonly prefetchCalls: TrackRequest[][] = [];
  get lastPrefetchIds(): string[] | null {
    return this.prefetchCalls[this.prefetchCalls.length - 1]?.map((r) => r.id) ?? null;
  }
  readonly prefetch = async (tracks: TrackRequest[]) => {
    this.prefetchCalls.push(tracks);
  };
  fetchProgress(id: string, cachedBytes: number, totalBytes: number) {
    this.emit(this.event('fetchProgress', id, { cachedBytes, totalBytes }));
  }
  /** Ids `cachedTracks` reports as fully cached. */
  cached = new Set<string>();
  cacheLimitBytes: number | null = null;
  cacheClears = 0;
  readonly cacheStats = async () => ({ usedBytes: 0, limitBytes: this.cacheLimitBytes ?? 0, entries: 0 });
  readonly cacheClear = async () => {
    this.cacheClears += 1;
  };
  readonly cacheSetLimit = async (bytes: number) => {
    this.cacheLimitBytes = bytes;
  };
  readonly cachedTracks = async (tracks: TrackRequest[]) =>
    tracks.filter((t) => this.cached.has(t.id)).map((t) => t.id);
  throughput(bps: number, id = 'x') {
    this.emit(this.event('throughput', id, { throughputBps: bps }));
  }
  readonly play = async () => {
    this.calls.push('play');
  };
  readonly pause = async () => {
    this.calls.push('pause');
  };
  readonly stop = async () => {
    this.calls.push('stop');
  };
  readonly seek = async (ms: number) => {
    this.calls.push(`seek(${ms})`);
  };
  readonly setDsp = async (c: DspConfig) => {
    this.calls.push('setDsp');
    this.lastDsp = c;
    if (this.rejectSettings) throw this.rejectSettings;
  };
}

// -------------------------------------------------------------- downloads

/** Fake of the Rust downloads commands. `start` completes when `finish` is called. */
export class FakeDownloadsEngine {
  records: DownloadRecord[] = [];
  readonly started: DownloadRequest[] = [];
  readonly cancelled: string[] = [];
  readonly deleted: string[] = [];
  /** Per-id error to reject `start` with. */
  failures = new Map<string, string>();
  /** When true, `start` stays pending until `finish(id)` / `cancel`. */
  manual = false;
  private pending = new Map<string, { resolve: (r: DownloadRecord) => void; reject: (e: unknown) => void }>();
  private listeners = new Set<(p: DownloadProgress) => void>();

  emitProgress(p: DownloadProgress) {
    for (const l of [...this.listeners]) l(p);
  }

  private makeRecord(req: DownloadRequest): DownloadRecord {
    return {
      id: req.id,
      path: `/dl/${req.id}.${req.extension}`,
      bytes: req.id.length * 100,
      addedAt: new Date(Date.UTC(2026, 0, 1 + this.records.length)).toISOString(),
      item: req.item,
    };
  }

  finish(id: string) {
    const p = this.pending.get(id);
    const req = this.started.find((r) => r.id === id);
    if (!p || !req) throw new Error(`nothing pending for ${id}`);
    this.pending.delete(id);
    const rec = this.makeRecord(req);
    this.records.push(rec);
    p.resolve(rec);
  }

  downloadsList = async () => [...this.records];
  readonly downloadsStart = (req: DownloadRequest): Promise<DownloadRecord> => {
    this.started.push(req);
    const failure = this.failures.get(req.id);
    if (failure) return Promise.reject(failure);
    if (this.manual) {
      return new Promise((resolve, reject) => this.pending.set(req.id, { resolve, reject }));
    }
    const rec = this.makeRecord(req);
    this.records.push(rec);
    return Promise.resolve(rec);
  };
  readonly downloadsCancel = async (id: string) => {
    this.cancelled.push(id);
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      p.reject('cancelled');
    }
  };
  downloadsDelete = async (id: string) => {
    this.deleted.push(id);
    this.records = this.records.filter((r) => r.id !== id);
  };
  readonly onDownloadProgress = async (cb: (p: DownloadProgress) => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
}

// ----------------------------------------------------------------- sockets

export class FakeSocket implements Socket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(
    private readonly onMessage: (text: string) => void,
    private readonly onClose: () => void,
  ) {}
  async send(text: string) {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  async close() {
    this.closed = true;
  }
  /** Server -> client frame. */
  push(type: string, data?: unknown) {
    this.onMessage(JSON.stringify({ MessageType: type, Data: data }));
  }
  pushRaw(text: string) {
    this.onMessage(text);
  }
  /** The remote side drops the connection. */
  drop() {
    this.onClose();
  }
}

export function fakeSocketFactory() {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const factory: SocketFactory = async (url, onMessage, onClose) => {
    urls.push(url);
    const s = new FakeSocket(onMessage, onClose);
    sockets.push(s);
    return s;
  };
  return { factory, sockets, urls, get last() { return sockets[sockets.length - 1]; } };
}

export function memorySecrets() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string | null) => {
      if (value === null || value === '') store.delete(key);
      else store.set(key, value);
    },
  };
}
