// Helpers for component tests. Not imported by app code.

import { APP_CONTEXT_KEY, createTestApp, type RaylaApp } from '../lib/app.svelte';
import type { CoreEngine } from '../lib/core.svelte';
import { memoryKv } from '../lib/platform';
import {
  FakeDownloadsEngine,
  FakeEngine,
  FakeHttp,
  fakeSocketFactory,
  flush,
  memorySecrets,
} from '../lib/test-support';
import { Router, ROUTER_KEY, UI_KEY, UiState } from './shell/router.svelte';
import { clearResourceCache } from './common/resource.svelte';

export const AUTH_ROUTES = {
  'POST /Users/AuthenticateByName': {
    AccessToken: 'tok',
    ServerId: 'srv',
    User: { Id: 'u1', Name: 'Ann' },
  },
  'POST /Sessions/Capabilities/Full': {},
  'POST /Sessions/Playing': {},
  'POST /Sessions/Playing/Progress': {},
  'POST /Sessions/Playing/Stopped': {},
};

export function buildApp(routes: Record<string, unknown> = {}) {
  // A fresh app is a fresh session: no screen data cached by an earlier test.
  clearResourceCache();
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
  const http = new FakeHttp({ ...AUTH_ROUTES, ...routes });
  const app: RaylaApp = createTestApp({
    engine: combined,
    fetch: http.fetch,
    kv: memoryKv(),
    openSocket: fakeSocketFactory().factory,
    secrets: memorySecrets(),
    generateDeviceId: () => 'dev-x',
    remoteBackoff: () => 0,
    setActivity: async () => {},
  });
  return { app, engine, dl, http };
}

/** Starts the app and signs in. */
export async function signedIn(routes: Record<string, unknown> = {}) {
  const built = buildApp(routes);
  await built.app.start();
  await built.app.core.sessions.login('https://jf.test', 'ann', 'pw');
  await flush();
  return built;
}

/** Render options providing app, router and ui through context. */
export function withContext(app: RaylaApp, router = new Router(), ui = new UiState()) {
  return {
    context: new Map<unknown, unknown>([
      [APP_CONTEXT_KEY, app],
      [ROUTER_KEY, router],
      [UI_KEY, ui],
    ]),
    router,
    ui,
  };
}
