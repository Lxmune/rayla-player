// Composition root: wires sessions, settings, player, downloads and the remote
// target. `createCore(deps)` takes everything injectable (tests use fakes);
// `createProductionCore()` binds the real Tauri seams. This is the only place
// that decides which implementation backs which interface.

import { untrack } from 'svelte';
import { DownloadsStore, type DownloadsEngine } from './downloads/store.svelte';
import { TrackStates } from './track-states.svelte';
import { FavoritesStore } from './jellyfin/favorites.svelte';
import { JellyfinRemote, RemoteController } from './jellyfin/remote';
import { SessionStore, type Secrets } from './jellyfin/session.svelte';
import { getNetworkType, onNetworkChanged } from './android';
import { ipc, type Ipc } from './ipc';
import { PlayerController, type NetworkSource, type PlayerEngine } from './player/controller.svelte';
import { EngineErrors, errorMessage } from './player/errors.svelte';
import { kvLongResume } from './player/long-resume';
import { parseResume, resumeKey, serializeResume } from './player/resume';
import { SleepTimer } from './player/sleep-timer.svelte';
import { httpFetch, localKv, openSocket, type HttpFetch, type KeyValueStore, type SocketFactory } from './platform';
import { SettingsStore, type SettingsEngine } from './settings/store.svelte';

export type CoreEngine = PlayerEngine &
  SettingsEngine &
  DownloadsEngine &
  Pick<Ipc, 'engineInitError' | 'cacheStats' | 'cacheClear' | 'cacheSetLimit' | 'cachedTracks'>;

export interface CoreDeps {
  engine: CoreEngine;
  fetch: HttpFetch;
  kv: KeyValueStore;
  openSocket: SocketFactory;
  secrets: Secrets;
  deviceName?: string;
  /** Connection type source (Android); none = always unmetered. */
  network?: NetworkSource;
  /** Test seams. */
  random?: () => number;
  now?: () => number;
  generateDeviceId?: () => string;
  remoteBackoff?: (attempt: number) => number;
}

export interface Core {
  sessions: SessionStore;
  settings: SettingsStore;
  player: PlayerController;
  sleep: SleepTimer;
  downloads: DownloadsStore;
  /** Download / stream-cache availability per track id. */
  trackStates: TrackStates;
  favorites: FavoritesStore;
  remote: RemoteController;
  /** Engine failure banner state. */
  errors: EngineErrors;
  /**
   * Startup: engine init error -> `errors`, push settings to the engine,
   * subscribe to engine events, read downloads and saved sessions, start the
   * remote target when signed in. Never rejects.
   */
  start(): Promise<void>;
  /** Stops the remote target and unsubscribes from the engine. */
  dispose(): Promise<void>;
}

export function createCore(deps: CoreDeps): Core {
  const errors = new EngineErrors();
  const settings = new SettingsStore({ kv: deps.kv, engine: deps.engine, errors });
  const sessions = new SessionStore({
    kv: deps.kv,
    secrets: deps.secrets,
    fetch: deps.fetch,
    deviceName: deps.deviceName,
    generateDeviceId: deps.generateDeviceId,
  });
  const downloads = new DownloadsStore({
    engine: deps.engine,
    client: () => sessions.client,
    errors,
    kv: deps.kv,
    profileId: () => sessions.active?.id ?? null,
  });
  const player = new PlayerController({
    engine: deps.engine,
    client: () => sessions.client,
    settings,
    downloads,
    errors,
    random: deps.random,
    now: deps.now,
    network: deps.network,
    longResume: kvLongResume(deps.kv, () => sessions.active?.id ?? null),
  });
  const trackStates = new TrackStates({
    engine: deps.engine,
    downloads,
    player,
    settings,
    client: () => sessions.client,
  });
  const sleep = new SleepTimer({
    player,
    now: deps.now,
    setVolumeScale: (scale) => void settings.setVolumeScale(scale),
    fadeEnabled: () => settings.current.playback.sleepFadeOut,
  });
  // Crossfade mode "shuffle": only crossfade while shuffling or playing a radio.
  settings.setCrossfadeGate(() => player.shuffle || player.radio !== null);
  const favorites = new FavoritesStore(() => sessions.client);
  const remote = new RemoteController(
    (client) =>
      new JellyfinRemote({
        client,
        player,
        volume: () => settings.current.dsp.volume,
        setVolume: (v) => settings.updateDsp({ volume: v }),
        shuffled: () => player.shuffle,
        connect: deps.openSocket,
        backoff: deps.remoteBackoff,
      }),
  );

  // Playback and the remote target belong to the old client: stop both before
  // the active profile changes, start the remote for the new one afterwards.
  sessions.beforeActiveChange(async () => {
    sleep.cancel();
    await remote.stop();
    await player.clear();
    const id = sessions.active?.id;
    if (id) deps.kv.set(resumeKey(id), null);
  });
  let started = false;
  sessions.onActiveChange(() => {
    if (started) void remote.sync(sessions.client);
  });

  // Resume playback: remember the queue and position (throttled while playing).
  const RESUME_THROTTLE_MS = 5000;
  const nowMs = deps.now ?? Date.now;
  let resumeReady = false;
  let lastSave = 0;
  function saveResume(): void {
    const id = sessions.active?.id;
    if (!resumeReady || !id || !settings.current.behavior.resumePlayback) return;
    if (player.queue.length === 0 || player.index < 0) return;
    lastSave = nowMs();
    deps.kv.set(
      resumeKey(id),
      serializeResume({
        items: player.queue.map((e) => e.item),
        index: player.index,
        positionMs: player.positionMs,
        shuffle: player.shuffle,
        repeat: player.repeat,
      }),
    );
  }
  const unlistenResume = player.onEngineEvent((e) => {
    if (e.kind === 'position') {
      if (nowMs() - lastSave >= RESUME_THROTTLE_MS) saveResume();
    } else if (e.kind === 'stateChanged' && e.state === 'paused') {
      saveResume();
    }
  });
  // Queue, order, repeat and the current entry changes save immediately.
  const stopResumeEffect = $effect.root(() => {
    $effect(() => {
      void [player.shuffle, player.radio];
      untrack(() => void settings.refreshDsp());
    });
    $effect(() => {
      void [player.queue, player.index, player.shuffle, player.repeat];
      untrack(saveResume);
    });
  });

  function restoreResume(): void {
    const id = sessions.active?.id;
    if (!id || !settings.current.behavior.resumePlayback || player.queue.length > 0) return;
    const snap = parseResume(deps.kv.get(resumeKey(id)));
    if (snap) player.restore(snap);
  }

  async function start(): Promise<void> {
    let initError: string | null = null;
    try {
      initError = await deps.engine.engineInitError();
    } catch (e) {
      initError = errorMessage(e);
    }
    if (initError) errors.report(`Audio engine failed to start: ${initError}`);
    else await settings.pushToEngine();

    await player.attach();
    await downloads.load();
    await sessions.load();
    restoreResume();
    void downloads.resume();
    resumeReady = true;
    started = true;
    await remote.sync(sessions.client);
  }

  async function dispose(): Promise<void> {
    started = false;
    saveResume();
    resumeReady = false;
    unlistenResume();
    stopResumeEffect();
    sleep.cancel();
    await remote.stop();
    player.dispose();
    downloads.dispose();
    trackStates.dispose();
  }

  return { sessions, settings, player, sleep, downloads, trackStates, favorites, remote, errors, start, dispose };
}

/** The real app: Tauri IPC, Rust-routed fetch, localStorage, OS keychain. */
export function createProductionCore(): Core {
  return createCore({
    engine: ipc,
    fetch: httpFetch,
    kv: localKv,
    openSocket,
    secrets: { get: (k) => ipc.secretGet(k), set: (k, v) => ipc.secretSet(k, v) },
    deviceName: 'Desktop',
    network: { get: getNetworkType, onChange: onNetworkChanged },
  });
}
