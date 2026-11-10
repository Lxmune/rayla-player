import { describe, expect, it } from 'vitest';
import { createCore, type CoreEngine } from './core.svelte';
import { memoryKv } from './platform';
import {
  FakeDownloadsEngine,
  FakeEngine,
  FakeHttp,
  fakeSocketFactory,
  flush,
  memorySecrets,
  track,
} from './test-support';

function build(opts: { initError?: string | null; kv?: ReturnType<typeof memoryKv> } = {}) {
  const engine = new FakeEngine();
  const dl = new FakeDownloadsEngine();
  const combined: CoreEngine = {
    onEngineEvent: engine.onEngineEvent,
    setOutput: engine.setOutput,
    setDsp: engine.setDsp,
    load: engine.load,
    setNext: engine.setNext,
    prefetch: engine.prefetch,
    cacheStats: engine.cacheStats,
    cacheClear: engine.cacheClear,
    cacheSetLimit: engine.cacheSetLimit,
    cachedTracks: engine.cachedTracks,
    play: engine.play,
    pause: engine.pause,
    stop: engine.stop,
    seek: engine.seek,
    downloadsList: dl.downloadsList,
    downloadsStart: dl.downloadsStart,
    downloadsCancel: dl.downloadsCancel,
    downloadsDelete: dl.downloadsDelete,
    onDownloadProgress: dl.onDownloadProgress,
    engineInitError: async () => opts.initError ?? null,
  };
  const http = new FakeHttp({
    'POST /Users/AuthenticateByName': {
      AccessToken: 'tok',
      ServerId: 'srv',
      User: { Id: 'u1', Name: 'Ann' },
    },
    'POST /Sessions/Capabilities/Full': {},
    'POST /Sessions/Playing': {},
    'POST /Sessions/Playing/Stopped': {},
  });
  const sockets = fakeSocketFactory();
  const kv = opts.kv ?? memoryKv();
  const secrets = memorySecrets();
  const core = createCore({
    engine: combined,
    fetch: http.fetch,
    kv,
    openSocket: sockets.factory,
    secrets,
    generateDeviceId: () => 'dev-x',
    remoteBackoff: () => 0,
  });
  return { core, engine, dl, http, sockets, kv, secrets };
}

describe('createCore', () => {
  it('start pushes settings, then a login starts the remote and playback works end to end', async () => {
    const { core, engine, http, sockets, dl } = build();
    await core.start();
    expect(core.errors.message).toBeNull();
    expect(engine.calls).toEqual(['setOutput(null,false)', 'setDsp']);
    expect(core.downloads.loaded).toBe(true);
    expect(core.sessions.loaded).toBe(true);
    expect(core.sessions.client).toBeNull();
    expect(core.remote.running).toBe(false);

    await core.sessions.login('https://jf.test', 'ann', 'pw');
    await flush();
    expect(core.remote.running).toBe(true);
    expect(sockets.urls).toEqual(['wss://jf.test/socket?api_key=tok&deviceId=dev-x']);

    await core.player.playQueue([track('a'), track('b')]);
    expect(engine.calls.slice(-2)).toEqual(['load(a,true)', 'setNext(b)']);
    expect(http.paths).toContain('/Sessions/Playing');

    // Engine events reach the player; downloads are visible to it.
    engine.trackStarted('b');
    expect(core.player.current?.id).toBe('b');
    await core.downloads.download([track('c')]);
    expect(dl.started.map((r) => r.id)).toEqual(['c']);

    // Volume set through the remote goes through settings to the engine.
    sockets.last?.push('GeneralCommand', { Name: 'SetVolume', Arguments: { Volume: 50 } });
    await core.remote.current?.idle;
    await flush();
    expect(core.settings.current.dsp.volume).toBe(0.5);
    expect(engine.lastDsp?.volume).toBe(0.5);

    await core.dispose();
  });

  it('signing out stops playback and the remote target', async () => {
    const { core, engine, sockets } = build();
    await core.start();
    await core.sessions.login('https://jf.test', 'ann', 'pw');
    await flush();
    await core.player.playQueue([track('a')]);
    await core.sessions.signOut();
    await flush();
    expect(core.player.queue).toEqual([]);
    expect(engine.calls[engine.calls.length - 1]).toBe('stop');
    expect(core.remote.running).toBe(false);
    expect(sockets.sockets[0]?.closed).toBe(true);
    await core.dispose();
  });

  it('restores the saved session on the next start and connects the remote', async () => {
    const first = build();
    await first.core.start();
    await first.core.sessions.login('https://jf.test', 'ann', 'pw');
    await first.core.dispose();

    const second = build({ kv: first.kv });
    // Same keychain contents as the first run.
    for (const [k, v] of first.secrets.store) second.secrets.store.set(k, v);
    await second.core.start();
    expect(second.core.sessions.active?.userName).toBe('Ann');
    expect(second.core.remote.running).toBe(true);
    expect(second.sockets.urls).toHaveLength(1);
    await second.core.dispose();
  });

  it('an engine init failure is shown as a banner and settings are not pushed', async () => {
    const { core, engine } = build({ initError: 'no audio device' });
    await core.start();
    expect(core.errors.message).toBe('Audio engine failed to start: no audio device');
    expect(engine.calls).toEqual([]);
    expect(core.sessions.loaded).toBe(true);
    core.errors.clear();
    expect(core.errors.message).toBeNull();
  });

  it('a rejecting engineInitError command is reported too', async () => {
    const { core, engine } = build();
    // Rebuild with a throwing init check.
    void engine;
    const bad = createCore({
      engine: {
        ...({} as CoreEngine),
        engineInitError: async () => {
          throw new Error('ipc down');
        },
        onEngineEvent: async () => () => {},
        onDownloadProgress: async () => () => {},
        downloadsList: async () => [],
      } as CoreEngine,
      fetch: new FakeHttp().fetch,
      kv: memoryKv(),
      openSocket: fakeSocketFactory().factory,
      secrets: memorySecrets(),
    });
    await bad.start();
    expect(bad.errors.message).toBe('Audio engine failed to start: ipc down');
  });

  it('resume playback: saves the queue and restores it paused on the next start', async () => {
    const first = build();
    await first.core.start();
    await first.core.sessions.login('https://jf.test', 'ann', 'pw');
    await flush();
    await first.core.player.playQueue([track('a'), track('b')], { startIndex: 1 });
    first.engine.state('paused');
    first.engine.position('b', 12000);
    await first.core.player.seek(12000);
    first.engine.state('paused');
    await flush();
    await first.core.dispose();

    const second = build({ kv: first.kv });
    for (const [k, v] of first.secrets.store) second.secrets.store.set(k, v);
    await second.core.start();
    expect(second.core.player.queue.map((e) => e.item.id)).toEqual(['a', 'b']);
    expect(second.core.player.current?.id).toBe('b');
    expect(second.core.player.positionMs).toBe(12000);
    expect(second.core.player.playback).toBe('stopped');
    expect(second.engine.calls).not.toContain('load(b,true)');
    await second.core.player.play();
    expect(second.engine.calls).toContain('seek(12000)');
    await second.core.dispose();
  });

  it('resume playback off: nothing is saved or restored', async () => {
    const first = build();
    await first.core.start();
    await first.core.sessions.login('https://jf.test', 'ann', 'pw');
    await first.core.settings.updateBehavior({ resumePlayback: false });
    await first.core.player.playQueue([track('a')]);
    await flush();
    const id = first.core.sessions.active?.id ?? '';
    expect(id).not.toBe('');
    await first.core.dispose();
    expect(first.kv.get(`player.resume.${id}`)).toBeNull();
  });
});
