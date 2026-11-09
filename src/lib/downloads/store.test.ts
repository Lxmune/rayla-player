import { describe, expect, it } from 'vitest';
import { parseBaseItem } from '../jellyfin/models';
import { EngineErrors } from '../player/errors.svelte';
import { FakeDownloadsEngine, FakeHttp, fakeClient, flush, track } from '../test-support';
import {
  DownloadsStore,
  extensionFor,
  formatBytes,
  progressFraction,
  type DownloadProgress,
} from './store.svelte';

function make(opts: { signedIn?: boolean } = {}) {
  const engine = new FakeDownloadsEngine();
  const client = fakeClient(new FakeHttp());
  const errors = new EngineErrors();
  const store = new DownloadsStore({
    engine,
    client: () => (opts.signedIn === false ? null : client),
    errors,
  });
  return { engine, store, client, errors };
}

describe('extensionFor', () => {
  it('uses the sanitized first container name, else bin', () => {
    expect(extensionFor(track('abc-123'))).toBe('flac');
    expect(extensionFor(parseBaseItem({ Id: 'x', MediaSources: [{ Id: 's', Container: 'mov,mp4,m4a' }] }))).toBe('mov');
    expect(extensionFor(parseBaseItem({ Id: 'x', MediaSources: [{ Id: 's', Container: '../!' }] }))).toBe('bin');
    expect(extensionFor(parseBaseItem({ Id: 'x' }))).toBe('bin');
  });
});

describe('DownloadsStore', () => {
  it('loads the Rust-side index, parsing items; pathFor/isDownloaded/totalBytes follow', async () => {
    const { engine, store } = make();
    engine.records = [
      { id: 'a', path: '/dl/a.flac', bytes: 5, addedAt: '2026-01-02T00:00:00Z', item: { Id: 'a', Name: 'A', NormalizationGain: -4.5 } },
      { id: 'b', path: '/dl/b.flac', bytes: 7, addedAt: '2026-01-03T00:00:00Z', item: 'garbage' },
    ];
    expect(store.loaded).toBe(false);
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.isDownloaded('a')).toBe(true);
    expect(store.pathFor('a')).toBe('/dl/a.flac');
    expect(store.pathFor('zzz')).toBeNull();
    expect(store.entries.get('a')?.item.normalizationGain).toBe(-4.5);
    expect(store.entries.get('b')?.item.id).toBe('b'); // id falls back to the record id
    expect(store.totalBytes).toBe(12);
    expect(store.sortedEntries.map((e) => e.id)).toEqual(['b', 'a']); // newest first
  });

  it('a failing index read still marks the store loaded', async () => {
    const { engine, store } = make();
    engine.downloadsList = async () => {
      throw new Error('no dir');
    };
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.entries.size).toBe(0);
  });

  it('downloads originals sequentially, sending url, headers, extension and the item JSON', async () => {
    const { engine, store, client } = make();
    await store.load();
    await store.download([track('a'), track('b')]);
    expect(store.active.size).toBe(0);
    expect([...store.entries.keys()]).toEqual(['a', 'b']);
    expect(engine.started.map((r) => r.id)).toEqual(['a', 'b']);
    const req = engine.started[0];
    expect(req?.url).toBe('https://jf.test/Items/a/Download');
    expect(req?.headers).toEqual(client.authHeaders());
    expect(req?.headers[0]?.value).toContain('Token="tok"');
    expect(req?.extension).toBe('flac');
    expect(parseBaseItem(req?.item).id).toBe('a');
    expect(store.pathFor('a')).toBe('/dl/a.flac');
    expect(store.entries.get('a')?.item.name).toBe('Track a'); // full item kept
    expect(store.totalBytes).toBe(200);
  });

  it('skips non-audio, already downloaded and already queued items', async () => {
    const { engine, store } = make();
    await store.load();
    await store.download([track('a'), { ...track('al'), type: 'MusicAlbum' }]);
    await store.download([track('a')]);
    expect(engine.started.map((r) => r.id)).toEqual(['a']);
  });

  it('delete removes the entry and asks Rust to delete the file', async () => {
    const { engine, store } = make();
    await store.load();
    await store.download([track('a')]);
    await store.delete('a');
    expect(store.entries.size).toBe(0);
    expect(engine.deleted).toEqual(['a']);
    await store.delete('a'); // unknown: no-op
    expect(engine.deleted).toEqual(['a']);
  });

  it('a failed delete keeps the entry and reports', async () => {
    const { engine, store, errors } = make();
    await store.load();
    await store.download([track('a')]);
    engine.downloadsDelete = async () => {
      throw 'disk is read-only';
    };
    await store.delete('a');
    expect(store.isDownloaded('a')).toBe(true);
    expect(errors.message).toBe('disk is read-only');
  });

  it('deleteAll removes everything', async () => {
    const { engine, store } = make();
    await store.load();
    await store.download([track('a'), track('b')]);
    await store.deleteAll();
    expect(store.entries.size).toBe(0);
    expect(engine.deleted.sort()).toEqual(['a', 'b']);
  });

  it('failure records the reason and leaves no active entry; retry clears it', async () => {
    const { engine, store } = make();
    await store.load();
    engine.failures.set('zzz', 'HTTP 404');
    await store.download([track('zzz')]);
    expect(store.entries.size).toBe(0);
    expect(store.active.size).toBe(0);
    expect(store.failed.get('zzz')?.reason).toBe('HTTP 404');
    engine.failures.clear();
    await store.download([track('zzz')]);
    expect(store.failed.size).toBe(0);
    expect(store.isDownloaded('zzz')).toBe(true);
  });

  it('signed out: fails with a reason', async () => {
    const { store, engine } = make({ signedIn: false });
    await store.load();
    await store.download([track('a')]);
    expect(store.failed.get('a')?.reason).toBe('Not signed in');
    expect(engine.started).toEqual([]);
  });

  it('a queued download can be cancelled before it starts', async () => {
    const { engine, store } = make();
    engine.manual = true;
    await store.load();
    const done = store.download([track('a'), track('b')]);
    await flush();
    expect(store.activeList.map((a) => [a.id, a.started])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    store.cancel('b');
    expect(store.active.has('b')).toBe(false);
    engine.finish('a');
    await done;
    expect([...store.entries.keys()]).toEqual(['a']);
    expect(engine.started.map((r) => r.id)).toEqual(['a']);
    expect(engine.cancelled).toEqual([]);
  });

  it('cancelling a running download asks Rust and leaves no failure', async () => {
    const { engine, store } = make();
    engine.manual = true;
    await store.load();
    const done = store.download([track('a'), track('b')]);
    await flush();
    store.cancel('a');
    await flush();
    expect(engine.cancelled).toEqual(['a']);
    engine.finish('b');
    await done;
    expect(store.failed.size).toBe(0);
    expect([...store.entries.keys()]).toEqual(['b']);
  });

  it('cancelAll cancels queued and running downloads', async () => {
    const { engine, store } = make();
    engine.manual = true;
    await store.load();
    const done = store.download([track('a'), track('b'), track('c')]);
    await flush();
    store.cancelAll();
    await done;
    expect(store.active.size).toBe(0);
    expect(engine.started.map((r) => r.id)).toEqual(['a']);
    expect(engine.cancelled).toEqual(['a']);
    expect(store.failed.size).toBe(0);
  });

  it('progress events update the matching active download', async () => {
    const { engine, store } = make();
    engine.manual = true;
    await store.load();
    const done = store.download([track('a')]);
    await flush();
    engine.emitProgress({ id: 'a', receivedBytes: 50, totalBytes: 200 });
    engine.emitProgress({ id: 'ghost', receivedBytes: 1, totalBytes: 2 });
    const p = store.active.get('a');
    expect(p).toMatchObject({ receivedBytes: 50, totalBytes: 200, started: true });
    expect(progressFraction(p as DownloadProgress)).toBe(0.25);
    engine.emitProgress({ id: 'a', receivedBytes: 80, totalBytes: null });
    expect(progressFraction(store.active.get('a') as DownloadProgress)).toBeNull();
    engine.finish('a');
    await done;
    expect(store.active.size).toBe(0);
  });

  it('formatBytes is re-exported for the downloads screen', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});
