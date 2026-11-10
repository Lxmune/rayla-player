import { describe, expect, it } from 'vitest';
import { memoryKv } from '../platform';
import { parseBaseItem } from '../jellyfin/models';
import { EngineErrors } from '../player/errors.svelte';
import { FakeDownloadsEngine, FakeHttp, fakeClient, flush, track } from '../test-support';
import {
  DownloadsStore,
  downloadSource,
  extensionFor,
  pendingKey,
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

describe('downloadSource', () => {
  const client = fakeClient(new FakeHttp());
  const flac = (bitrate: number) =>
    parseBaseItem({ Id: 'x', Type: 'Audio', MediaSources: [{ Id: 's', Container: 'flac', Bitrate: bitrate }] });

  it('original: the Download endpoint and the source extension', () => {
    expect(downloadSource(client, flac(900_000), 'original')).toEqual({
      url: 'https://jf.test/Items/x/Download',
      extension: 'flac',
    });
  });

  it('a cap: the universal endpoint; codec extension only when the source is above it', () => {
    const aac = downloadSource(client, flac(900_000), 'aac-128');
    expect(aac.url).toContain('/Audio/x/universal');
    expect(aac.url).toContain('MaxStreamingBitrate=128000');
    expect(aac.url).toContain('AudioCodec=aac');
    expect(aac.extension).toBe('aac');
    const cd = downloadSource(client, flac(2_800_000), 'flac-cd');
    expect(cd.url).toContain('MaxAudioBitDepth=16');
    expect(cd.extension).toBe('flac');
    const mp3 = parseBaseItem({ Id: 'y', Type: 'Audio', MediaSources: [{ Id: 's', Container: 'mp3', Bitrate: 128_000 }] });
    expect(downloadSource(client, mp3, 'aac-192').extension).toBe('mp3'); // already below: sent as is
  });
});

describe('DownloadsStore', () => {
  it('downloads at the configured quality', async () => {
    const engine = new FakeDownloadsEngine();
    const client = fakeClient(new FakeHttp());
    const store = new DownloadsStore({ engine, client: () => client, quality: () => 'mp3-320' });
    await store.load();
    await store.download([track('a')]);
    expect(engine.started[0]?.url).toContain('AudioCodec=mp3');
  });

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

  describe('resume', () => {
    function makeKv() {
      const engine = new FakeDownloadsEngine();
      const client = fakeClient(new FakeHttp());
      const kv = memoryKv();
      const mk = () => new DownloadsStore({ engine, client: () => client, kv, profileId: () => 'p1' });
      return { engine, kv, mk };
    }
    const saved = (kv: ReturnType<typeof memoryKv>) =>
      JSON.parse(kv.get(pendingKey('p1')) ?? '[]').map((i: { Id: string }) => i.Id);

    it('remembers unfinished downloads without secrets, and clears them when done', async () => {
      const { engine, kv, mk } = makeKv();
      engine.manual = true;
      const store = mk();
      await store.load();
      const done = store.download([track('a'), track('b')]);
      await flush();
      expect(saved(kv)).toEqual(['a', 'b']);
      expect(kv.get(pendingKey('p1'))).not.toContain('tok');
      engine.finish('a');
      await flush();
      engine.finish('b');
      await done;
      expect(kv.get(pendingKey('p1'))).toBeNull();
    });

    it('a new store restarts them; failed ones stay listed and can be retried', async () => {
      const { engine, kv, mk } = makeKv();
      engine.failures.set('a', 'boom');
      const first = mk();
      await first.load();
      await first.download([track('a')]);
      expect(first.failed.get('a')?.reason).toBe('boom');
      expect(saved(kv)).toEqual(['a']);

      engine.failures.clear();
      const second = mk();
      await second.load();
      await second.resume();
      expect(second.isDownloaded('a')).toBe(true);
      expect(kv.get(pendingKey('p1'))).toBeNull();
    });

    it('retry and retryAll requeue failures; dismiss forgets one', async () => {
      const { engine, kv, mk } = makeKv();
      engine.failures.set('a', 'x');
      engine.failures.set('b', 'y');
      engine.failures.set('c', 'z');
      const store = mk();
      await store.load();
      await store.download([track('a'), track('b'), track('c')]);
      store.dismiss('c');
      expect(saved(kv)).toEqual(['a', 'b']);
      engine.failures.delete('a');
      await store.retry('a');
      expect(store.isDownloaded('a')).toBe(true);
      engine.failures.clear();
      await store.retryAll();
      expect(store.isDownloaded('b')).toBe(true);
      expect(store.failed.size).toBe(0);
      expect(kv.get(pendingKey('p1'))).toBeNull();
    });

    it('a profile switch mid-download keeps each pending item under the profile that queued it', async () => {
      const engine = new FakeDownloadsEngine();
      const client = fakeClient(new FakeHttp());
      const kv = memoryKv();
      let profile = 'p1';
      engine.manual = true;
      const store = new DownloadsStore({ engine, client: () => client, kv, profileId: () => profile });
      await store.load();
      void store.download([track('a')]);
      await flush();
      profile = 'p2';
      void store.download([track('b')]);
      await flush();
      const ids = (p: string) => JSON.parse(kv.get(pendingKey(p)) ?? '[]').map((i: { Id: string }) => i.Id);
      expect(ids('p1')).toEqual(['a']);
      expect(ids('p2')).toEqual(['b']);
      engine.finish('a');
      await flush();
      expect(kv.get(pendingKey('p1'))).toBeNull();
      expect(ids('p2')).toEqual(['b']);
    });

    it('cancel removes the download from the pending list', async () => {
      const { engine, kv, mk } = makeKv();
      engine.manual = true;
      const store = mk();
      await store.load();
      void store.download([track('a'), track('b')]);
      await flush();
      store.cancel('b');
      expect(saved(kv)).toEqual(['a']);
      store.cancel('a');
      expect(kv.get(pendingKey('p1'))).toBeNull();
    });
  });

  it('formatBytes is re-exported for the downloads screen', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});

describe('DownloadsStore Wi-Fi only', () => {
  it('waits on cellular and continues when the network changes', async () => {
    const engine = new FakeDownloadsEngine();
    const client = fakeClient(new FakeHttp());
    let emit: (t: 'wifi' | 'cellular' | 'none' | 'other') => void = () => {};
    let wifiOnly = true;
    const store = new DownloadsStore({
      engine,
      client: () => client,
      wifiOnly: () => wifiOnly,
      network: { get: async () => 'cellular', onChange: (cb) => ((emit = cb), () => {}) },
    });
    await store.load();
    void store.download([track('a')]);
    await flush();
    expect(engine.started).toHaveLength(0);
    expect(store.waitingForWifi).toBe(true);
    emit('wifi');
    await store.idle;
    expect(engine.started.map((r) => r.id)).toEqual(['a']);
    expect(store.waitingForWifi).toBe(false);
    // Turning the setting off releases a waiting queue.
    emit('none');
    void store.download([track('b')]);
    await flush();
    expect(engine.started).toHaveLength(1);
    wifiOnly = false;
    store.recheck();
    await store.idle;
    expect(engine.started.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('never blocks on desktop (other)', async () => {
    const engine = new FakeDownloadsEngine();
    const store = new DownloadsStore({
      engine,
      client: () => fakeClient(new FakeHttp()),
      wifiOnly: () => true,
      network: { get: async () => 'other', onChange: () => () => {} },
    });
    await store.load();
    await store.download([track('a')]);
    expect(engine.started).toHaveLength(1);
  });
});
