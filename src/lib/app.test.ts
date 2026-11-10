import { describe, expect, it } from 'vitest';
import { createTestApp } from './app.svelte';
import type { CoreEngine } from './core.svelte';
import type { DiscordActivity } from './ipc';
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

function build(android?: { enabled: boolean; bridge: any }) {
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
    engineInitError: async () => null,
  };
  const activities: Array<[string, DiscordActivity | null]> = [];
  const app = createTestApp({
    engine: combined,
    fetch: new FakeHttp({}).fetch,
    kv: memoryKv(),
    openSocket: fakeSocketFactory().factory,
    secrets: memorySecrets(),
    generateDeviceId: () => 'dev-x',
    remoteBackoff: () => 0,
    android,
    setActivity: async (id, a) => {
      activities.push([id, a]);
    },
  });
  return { app, engine, activities };
}

describe('createApp wiring', () => {
  it('drives Discord presence from player events and settings changes', async () => {
    const { app, engine, activities } = build();
    await app.start();
    app.core.settings.updateDiscord({ enabled: true, applicationId: '123456789012345678' });
    await app.core.player.playQueue([track('a')]);
    engine.trackStarted('a');
    await flush();
    const shown = activities.filter(([, a]) => a !== null);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.at(-1)?.[0]).toBe('123456789012345678');

    app.core.settings.updateDiscord({ enabled: false });
    await flush();
    expect(activities.at(-1)?.[1]).toBeNull();
    await app.dispose();
  });

  it('wires the Android media session only when enabled', async () => {
    for (const enabled of [false, true]) {
      const updates: unknown[] = [];
      const bridge = {
        updateNowPlaying: async (i: unknown) => void updates.push(i),
        clearNowPlaying: async () => {},
        onMediaAction: async () => () => {},
      };
      const { app, engine } = build({ enabled, bridge });
      await app.start();
      await app.core.player.playQueue([track('a')]);
      engine.trackStarted('a');
      engine.state('playing');
      await new Promise((r) => setTimeout(r, 80));
      expect(updates.length > 0).toBe(enabled);
      await app.dispose();
    }
  });
});
