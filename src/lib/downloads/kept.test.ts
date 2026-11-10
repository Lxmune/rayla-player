import { describe, expect, it } from 'vitest';
import type { NetworkType } from '../android';
import { parseBaseItem, type BaseItem } from '../jellyfin/models';
import { memoryKv } from '../platform';
import { FakeDownloadsEngine, FakeHttp, fakeClient, flush, track } from '../test-support';
import { KeptStore, keptKey } from './kept.svelte';
import { DownloadsStore } from './store.svelte';

const album = (id: string, type = 'MusicAlbum') => parseBaseItem({ Id: id, Name: `Name ${id}`, Type: type });

function make() {
  const engine = new FakeDownloadsEngine();
  const base = fakeClient(new FakeHttp());
  const lists: Record<string, BaseItem[]> = {};
  const client = base;
  client.tracksOf = async (i: BaseItem) => lists[i.id] ?? [];
  const kv = memoryKv();
  const downloads = new DownloadsStore({ engine, client: () => client, kv, profileId: () => 'p1' });
  let onNet: ((t: NetworkType) => void) | null = null;
  const kept = new KeptStore({
    downloads,
    client: () => client,
    kv,
    profileId: () => 'p1',
    network: { onChange: (cb) => ((onNet = cb), () => {}) },
    setInterval: () => 1,
    clearInterval: () => {},
  });
  return { engine, downloads, kept, lists, kv, net: (t: NetworkType) => onNet?.(t) };
}

describe('KeptStore', () => {
  it('keeping an album downloads its tracks and persists', async () => {
    const m = make();
    await m.downloads.load();
    m.lists.A = [track('1'), track('2')];
    await m.kept.setKept(album('A'), true);
    await m.downloads.idle;
    expect(m.engine.started.map((r) => r.id)).toEqual(['1', '2']);
    expect(m.kept.isKept('A')).toBe(true);
    expect(m.kept.progress('A')).toEqual({ have: 2, total: 2 });
    expect(m.kv.get(keptKey('p1'))).toContain('"A"');
  });

  it('a playlist sync removes tracks that left it but not individual downloads', async () => {
    const m = make();
    await m.downloads.load();
    await m.downloads.download([track('u')]); // the user's own
    m.lists.P = [track('1'), track('2'), track('u')];
    await m.kept.setKept(album('P', 'Playlist'), true);
    await m.downloads.idle;
    expect(m.engine.started.map((r) => r.id).sort()).toEqual(['1', '2', 'u']);
    m.lists.P = [track('1'), track('u')];
    await m.kept.sync();
    await flush();
    expect(m.engine.deleted).toEqual(['2']);
    m.lists.P = [];
    await m.kept.sync();
    await flush();
    expect(m.engine.deleted.sort()).toEqual(['1', '2']);
    expect(m.downloads.isDownloaded('u')).toBe(true);
  });

  it('un-keeping releases tracks no other collection needs', async () => {
    const m = make();
    await m.downloads.load();
    m.lists.A = [track('1'), track('2')];
    m.lists.B = [track('2')];
    await m.kept.setKept(album('A'), true);
    await m.kept.setKept(album('B'), true);
    await m.downloads.idle;
    await m.kept.setKept(album('A'), false);
    await flush();
    expect(m.engine.deleted).toEqual(['1']);
    expect(m.kept.isKept('A')).toBe(false);
  });

  it('syncs when the network becomes unmetered', async () => {
    const m = make();
    await m.downloads.load();
    await m.kept.start();
    m.lists.A = [track('1')];
    await m.kept.setKept(album('A'), true);
    await m.downloads.idle;
    m.lists.A = [track('1'), track('2')];
    m.net('cellular');
    await flush();
    expect(m.engine.started.map((r) => r.id)).toEqual(['1']);
    m.net('wifi');
    await flush();
    await m.downloads.idle;
    expect(m.engine.started.map((r) => r.id)).toEqual(['1', '2']);
  });
});
