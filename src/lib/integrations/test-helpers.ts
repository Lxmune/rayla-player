import type { HttpFetch } from '../platform';
import type { TrackMeta } from '../track-meta';

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Fake fetch answering with `respond(req)` and recording requests. */
export function fakeFetch(respond: (r: Recorded) => [number, string] | Error) {
  const requests: Recorded[] = [];
  const fn: HttpFetch = async (input, init) => {
    const req: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === 'string' ? init.body : '',
    };
    requests.push(req);
    const r = respond(req);
    if (r instanceof Error) throw r;
    return new Response(r[1], { status: r[0] });
  };
  return { fn, requests };
}

export function meta(over: Partial<TrackMeta> = {}): TrackMeta {
  return {
    id: 't1',
    albumId: 'a1',
    imageItemId: 't1',
    title: 'Teardrop',
    artists: ['Massive Attack'],
    album: 'Mezzanine',
    albumArtist: 'Massive Attack',
    year: 1998,
    trackNumber: 3,
    durationMs: 329_000,
    container: 'flac',
    codec: 'flac',
    sampleRate: 44100,
    bitDepth: 16,
    bitrate: null,
    ...over,
  };
}
