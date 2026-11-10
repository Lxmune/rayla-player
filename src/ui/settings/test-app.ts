// Test helper for the settings / sheets / downloads components.
import { APP_CONTEXT_KEY, createTestApp } from '../../lib/app.svelte';
import type { CoreEngine } from '../../lib/core.svelte';
import type { DiscordActivity } from '../../lib/ipc';
import type { HttpFetch } from '../../lib/platform';
import { memoryKv } from '../../lib/platform';
import {
  FakeDownloadsEngine,
  FakeEngine,
  FakeHttp,
  fakeSocketFactory,
  memorySecrets,
} from '../../lib/test-support';

export function buildApp(opts: { fetch?: HttpFetch } = {}) {
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
    downloadsSetDir: dl.downloadsSetDir,
    onDownloadProgress: dl.onDownloadProgress,
    engineInitError: async () => null,
  };
  const secrets = memorySecrets();
  const http = new FakeHttp({
    'POST /Users/AuthenticateByName': {
      AccessToken: 'tok',
      ServerId: 'srv',
      User: { Id: 'u1', Name: 'Ann' },
    },
    'POST /Sessions/Capabilities/Full': {},
    'POST /Sessions/Playing': {},
    'POST /Sessions/Playing/Stopped': {},
    'POST /Sessions/Playing/Progress': {},
  });
  const app = createTestApp({
    engine: combined,
    fetch: opts.fetch ?? http.fetch,
    kv: memoryKv(),
    openSocket: fakeSocketFactory().factory,
    secrets,
    generateDeviceId: () => 'dev-x',
    remoteBackoff: () => 0,
    setActivity: async (_id: string, _a: DiscordActivity | null) => {},
  });
  const context = new Map<symbol, unknown>([[APP_CONTEXT_KEY, app]]);
  /** Starts the app and signs in to the fake server (needed to play / download). */
  const ready = async () => {
    await app.start();
    await app.core.sessions.login('https://jf.test', 'ann', 'pw');
  };
  return { app, engine, dl, secrets, context, ready };
}
