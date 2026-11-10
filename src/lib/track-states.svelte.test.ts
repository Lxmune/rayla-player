import { describe, expect, it } from 'vitest';
import { DownloadsStore } from './downloads/store.svelte';
import { memoryKv } from './platform';
import { PlayerController } from './player/controller.svelte';
import { EngineErrors } from './player/errors.svelte';
import { SettingsStore } from './settings/store.svelte';
import { FakeDownloadsEngine, FakeEngine, FakeHttp, fakeClient, flush, track } from './test-support';
import { TrackStates, availabilityLabel } from './track-states.svelte';

async function setup() {
  const engine = new FakeEngine();
  const dlEngine = new FakeDownloadsEngine();
  const client = fakeClient(new FakeHttp({ 'POST /Sessions/Playing': {}, 'POST /Sessions/Playing/Stopped': {} }));
  const errors = new EngineErrors();
  const settings = new SettingsStore({ kv: memoryKv(), engine, errors });
  const downloads = new DownloadsStore({ engine: dlEngine, client: () => client, errors });
  const player = new PlayerController({ engine, client: () => client, settings, downloads, errors });
  await player.attach();
  await downloads.load();
  const states = new TrackStates({ engine, downloads, player, settings, client: () => client, debounceMs: 0 });
  await flush();
  return { engine, dlEngine, downloads, player, states };
}

const wait = () => new Promise((r) => setTimeout(r, 5));

describe('TrackStates', () => {
  it('is none by default, and downloads beat the stream cache', async () => {
    const t = await setup();
    expect(t.states.get('a').kind).toBe('none');
    t.engine.fetchProgress('a', 50, 100);
    await flush();
    expect(t.states.get('a')).toEqual({ kind: 'caching', fraction: 0.5 });
    t.engine.fetchProgress('a', 100, 100);
    await flush();
    expect(t.states.get('a').kind).toBe('cached');
    t.dlEngine.records = [{ id: 'a', path: '/dl/a.flac', bytes: 1, addedAt: '2026-01-01T00:00:00Z', item: { Id: 'a' } }];
    await t.downloads.load();
    expect(t.states.get('a').kind).toBe('downloaded');
    t.states.dispose();
  });

  it('reports download progress and unknown totals', async () => {
    const t = await setup();
    t.dlEngine.manual = true;
    void t.downloads.download([track('a'), track('b')]);
    await flush();
    t.dlEngine.emitProgress({ id: 'a', receivedBytes: 40, totalBytes: 100 });
    expect(t.states.get('a')).toEqual({ kind: 'downloading', fraction: 0.4 });
    expect(t.states.get('b')).toEqual({ kind: 'downloading', fraction: 0 });
    t.engine.fetchProgress('z', 10, 0);
    expect(t.states.get('z')).toEqual({ kind: 'caching', fraction: null });
    t.states.dispose();
  });

  it('looks up the queue in the stream cache', async () => {
    const t = await setup();
    t.engine.cached.add('b');
    await t.player.playQueue([track('a'), track('b')]);
    await wait();
    await flush();
    expect(t.states.get('b').kind).toBe('cached');
    expect(t.states.get('a').kind).toBe('none');
    t.states.dispose();
  });

  it('labels', () => {
    expect(availabilityLabel({ kind: 'downloading', fraction: 0.4 })).toBe('Downloading 40 %');
    expect(availabilityLabel({ kind: 'caching', fraction: 0.4 })).toBe('Buffering 40 %');
    expect(availabilityLabel({ kind: 'cached' })).toBe('Cached for playback');
    expect(availabilityLabel({ kind: 'none' })).toBeNull();
  });
});
