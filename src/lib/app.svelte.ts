// FROZEN app root for the UI: the core stores plus the integrations, wired to
// player events and settings changes. Components get it with `getApp()`;
// App.svelte creates it once and calls `provideApp(app)`.

import { getContext, setContext } from 'svelte';
import { createCore, createProductionCore, type Core, type CoreDeps } from './core.svelte';
import { ipc } from './ipc';
import { httpFetch, localKv, type HttpFetch, type KeyValueStore } from './platform';
import type { Secrets } from './jellyfin/session.svelte';
import { IntegrationCredentials, createScrobbleService } from './integrations/credentials.svelte';
import { DiscordPresence, type PresenceObservation, type SetActivity } from './integrations/discord-presence';

export interface RaylaApp {
  core: Core;
  /** ListenBrainz / Last.fm credentials (OS keychain). */
  credentials: IntegrationCredentials;
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
  const presence = new DiscordPresence(deps.setActivity, deps.clock);
  const unsubscribe: Array<() => void> = [];
  /** Latest player observation, re-sent to Discord when its settings change. */
  let last: PresenceObservation = {
    meta: null, entryId: null, state: 'stopped', positionMs: 0, durationMs: 0, signalPath: null,
  };
  const observePresence = () => void presence.observe(core.settings.current.discord, last);

  return {
    core,
    credentials,
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
          void scrobble.tracker.observe({ ...last, playing: e.state === 'playing' });
          observePresence();
        }),
        core.settings.onChange((s, prev) => {
          if (s.discord !== prev.discord) observePresence();
        }),
      );
      void scrobble.flushPending().catch(() => {});
    },
    async dispose() {
      unsubscribe.splice(0).forEach((u) => u());
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
export function createTestApp(deps: CoreDeps & { setActivity: SetActivity }): RaylaApp {
  return createApp(createCore(deps), deps);
}

/** Context key; component tests pass `context: new Map([[APP_CONTEXT_KEY, app]])`. */
export const APP_CONTEXT_KEY = Symbol('rayla-app');
const KEY = APP_CONTEXT_KEY;
export const provideApp = (app: RaylaApp): RaylaApp => setContext(KEY, app);
export const getApp = (): RaylaApp => getContext<RaylaApp>(KEY);
