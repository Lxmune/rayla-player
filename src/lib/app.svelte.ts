// FROZEN app root for the UI: the core stores plus the integrations, wired to
// player events and settings changes. Components get it with `getApp()`;
// App.svelte creates it once and calls `provideApp(app)`.

import { getContext, setContext } from 'svelte';
import { createCore, createProductionCore, type Core, type CoreDeps } from './core.svelte';
import { isAndroid, clearNowPlaying, onMediaAction, updateNowPlaying } from './android';
import { desktopMediaBridge, isDesktop } from './desktop-media';
import { imageItemId } from './jellyfin/models';
import { MediaSession, type MediaBridge } from './integrations/media-session';
import { ipc } from './ipc';
import { httpFetch, localKv, type HttpFetch, type KeyValueStore } from './platform';
import type { Secrets } from './jellyfin/session.svelte';
import { IntegrationCredentials, createScrobbleService } from './integrations/credentials.svelte';
import { SkipTracker } from './recommend/skips.svelte';
import { ListenLog } from './stats/listen-log.svelte';
import { DiscordPresence, type PresenceObservation, type SetActivity } from './integrations/discord-presence';

export interface RaylaApp {
  core: Core;
  /** Key/value storage (per-device caches such as the daily mixes). */
  kv: KeyValueStore;
  /** ListenBrainz / Last.fm credentials (OS keychain). */
  credentials: IntegrationCredentials;
  /** Learns which tracks the user skips (feeds Discover and radio). */
  skips: SkipTracker;
  /** Records what is listened to (feeds the Stats screen). */
  listens: ListenLog;
  /** Starts the core, loads credentials, flushes pending scrobbles. Never rejects. */
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export interface IntegrationDeps {
  fetch: HttpFetch;
  kv: KeyValueStore;
  secrets: Secrets;
  setActivity: SetActivity;
  clock?: () => number;
  /**
   * OS media session switch / bridge: the rayla-android plugin on Android, desktop media
   * controls (SMTC / Now Playing / MPRIS) in the desktop shell, off elsewhere (tests, browser).
   */
  android?: { enabled: boolean; bridge: MediaBridge };
}

export function createApp(core: Core, deps: IntegrationDeps): RaylaApp {
  const credentials = new IntegrationCredentials(deps.secrets, deps.fetch);
  const scrobble = createScrobbleService({
    fetch: deps.fetch,
    kv: deps.kv,
    credentials,
    toggles: () => core.settings.current,
    clock: deps.clock,
  });
  const skips = new SkipTracker({
    kv: deps.kv,
    profileId: () => core.sessions.activeId,
    queue: () => core.player.queue,
    clock: deps.clock,
  });
  const listens = new ListenLog({ kv: deps.kv, profileId: () => core.sessions.activeId, clock: deps.clock });
  const presence = new DiscordPresence(deps.setActivity, deps.clock);
  const unsubscribe: Array<() => void> = [];
  /** Latest player observation, re-sent to Discord when its settings change. */
  let last: PresenceObservation = {
    meta: null, entryId: null, state: 'stopped', positionMs: 0, durationMs: 0, signalPath: null,
  };
  const observePresence = () => void presence.observe(core.settings.current.discord, last);

  return {
    core,
    kv: deps.kv,
    credentials,
    skips,
    listens,
    async start() {
      await core.start();
      try {
        await credentials.load();
      } catch (e) {
        core.errors.report(e);
      }
      unsubscribe.push(
        core.player.onEngineEvent((e) => {
          last = {
            meta: e.meta,
            entryId: e.entryId,
            state: e.state,
            positionMs: e.positionMs,
            durationMs: e.durationMs,
            // Engine events carry a path only on signalPathChanged; use the tracked one.
            signalPath: core.player.signalPath,
          };
          skips.observe(e);
          listens.observe(e);
          void scrobble.tracker.observe({ ...last, playing: e.state === 'playing' });
          observePresence();
        }),
        core.settings.onChange((s, prev) => {
          if (s.discord !== prev.discord) observePresence();
        }),
      );
      const android =
        deps.android ??
        (isAndroid
          ? { enabled: true, bridge: { updateNowPlaying, clearNowPlaying, onMediaAction } }
          : { enabled: isDesktop, bridge: desktopMediaBridge });
      if (android.enabled) {
        const session = new MediaSession({
          player: core.player,
          bridge: android.bridge,
          artUrl: (item) => {
            const client = core.sessions.client;
            return client
              ? client.imageUrl(imageItemId(item), { maxWidth: 512, tag: item.primaryImageTag })
              : null;
          },
          onError: (e) => core.errors.report(e),
          // Notification / lock-screen heart and "not for me".
          isLiked: (item) => core.favorites.isFavorite(item),
          onLike: () => {
            const it = core.player.current;
            if (it) void core.favorites.toggle(it).catch((e) => core.errors.report(e));
          },
          onDislike: () => {
            const it = core.player.current;
            if (!it) return;
            skips.dislike(it);
            void core.player.next().catch((e) => core.errors.report(e));
          },
        });
        void session.start();
        // Re-push when the current track's favourite state changes (from the UI or the
        // notification), so the notification heart stays in sync.
        const stopLikeWatch = $effect.root(() => {
          $effect(() => {
            const it = core.player.current;
            if (it) core.favorites.isFavorite(it);
            session.observe();
          });
        });
        unsubscribe.push(
          () => session.dispose(),
          stopLikeWatch,
          core.sessions.onActiveChange(() => session.observe()),
        );
      }
      void scrobble.flushPending().catch(() => {});
    },
    async dispose() {
      unsubscribe.splice(0).forEach((u) => u());
      listens.flush();
      await presence.clear();
      await core.dispose();
    },
  };
}

export function createProductionApp(): RaylaApp {
  return createApp(createProductionCore(), {
    fetch: httpFetch,
    kv: localKv,
    secrets: { get: (k) => ipc.secretGet(k), set: (k, v) => ipc.secretSet(k, v) },
    setActivity: (id, a) => ipc.discordSetActivity(id, a),
  });
}

/** For tests: an app over `createCore(deps)` with the same fakes. */
export function createTestApp(deps: CoreDeps & { setActivity: SetActivity; android?: IntegrationDeps["android"] }): RaylaApp {
  return createApp(createCore(deps), deps);
}

/** Context key; component tests pass `context: new Map([[APP_CONTEXT_KEY, app]])`. */
export const APP_CONTEXT_KEY = Symbol('rayla-app');
const KEY = APP_CONTEXT_KEY;
export const provideApp = (app: RaylaApp): RaylaApp => setContext(KEY, app);
export const getApp = (): RaylaApp => getContext<RaylaApp>(KEY);
