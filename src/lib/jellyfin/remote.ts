// Makes this app a Jellyfin "Now Playing" remote-control target: registers
// capabilities, keeps the session websocket alive and executes the commands
// other Jellyfin clients send.

import type { SocketFactory, Socket } from '../platform';
import type { PlayerController, RepeatMode } from '../player/controller.svelte';
import type { JellyfinClient } from './client';
import { isObject, type BaseItem } from './models';

/** Reconnect delay (ms) after `attempt` consecutive failures (0-based): 1, 2, 4 ... capped at 60 s. */
export function remoteBackoff(attempt: number): number {
  return Math.min(60, 1 << Math.min(attempt, 6)) * 1000;
}

/** The slice of the player the remote drives. */
export type RemotePlayer = Pick<
  PlayerController,
  | 'playQueue'
  | 'playNext'
  | 'addToQueue'
  | 'playInstantMix'
  | 'seek'
  | 'stop'
  | 'pause'
  | 'play'
  | 'togglePlay'
  | 'next'
  | 'previous'
  | 'setRepeat'
  | 'toggleShuffle'
  | 'reportNow'
>;

export interface RemoteDeps {
  client: JellyfinClient;
  player: RemotePlayer;
  /** Current volume, 0..1. */
  volume: () => number;
  /** Applies a volume 0..1. */
  setVolume: (v: number) => Promise<void>;
  /** Whether the queue is currently shuffled. */
  shuffled: () => boolean;
  connect: SocketFactory;
  backoff?: (attempt: number) => number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ticksToMs = (ticks: number) => Math.floor(ticks / 10000);

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export class JellyfinRemote {
  private readonly deps: RemoteDeps;
  private readonly backoff: (attempt: number) => number;
  private socket: Socket | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private _running = false;
  private failures = 0;
  private volumeBeforeMute = 1;
  /** Bumped whenever the current connection attempt/socket becomes stale. */
  private generation = 0;
  private work: Promise<void> = Promise.resolve();

  constructor(deps: RemoteDeps) {
    this.deps = deps;
    this.backoff = deps.backoff ?? remoteBackoff;
  }

  get running(): boolean {
    return this._running;
  }

  /** Completes when all commands received so far have been executed. */
  get idle(): Promise<void> {
    return this.work;
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    await this.open();
  }

  private async open(): Promise<void> {
    if (!this._running) return;
    const gen = ++this.generation;
    try {
      await this.deps.client.postCapabilities();
      const socket = await this.deps.connect(
        this.deps.client.socketUrl,
        (text) => {
          if (gen === this.generation) this.onMessage(text);
        },
        () => {
          if (gen === this.generation) this.lost();
        },
      );
      if (!this._running || gen !== this.generation) {
        await socket.close().catch(() => {});
        return;
      }
      this.socket = socket;
      // Optimistic: the server's ForceKeepAlive sets the real interval.
      this.startKeepAlive(60);
    } catch {
      if (gen === this.generation) this.lost();
    }
  }

  private lost(): void {
    this.generation++;
    this.clearKeepAlive();
    const stale = this.socket;
    this.socket = null;
    stale?.close().catch(() => {});
    if (!this._running) return;
    const delay = this.backoff(this.failures++);
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.open(), delay);
  }

  async stop(): Promise<void> {
    this._running = false;
    this.generation++;
    this.clearKeepAlive();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    try {
      await socket?.close();
    } catch {
      // already closed
    }
  }

  private clearKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  private startKeepAlive(seconds: number): void {
    this.clearKeepAlive();
    // Jellyfin asks for a KeepAlive within `seconds`; answer at half that.
    const period = Math.max(500, Math.round(seconds * 500));
    this.keepAlive = setInterval(() => this.send({ MessageType: 'KeepAlive' }), period);
  }

  private send(message: Record<string, unknown>): void {
    // The close callback handles reconnecting when this fails.
    this.socket?.send(JSON.stringify(message)).catch(() => {});
  }

  /** Entry point for each websocket frame (public for tests). */
  onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isObject(decoded)) return;
    const type = typeof decoded.MessageType === 'string' ? decoded.MessageType : null;
    const data = decoded.Data;
    if (type === 'ForceKeepAlive') {
      this.failures = 0;
      this.startKeepAlive(typeof data === 'number' ? data : 60);
      this.send({ MessageType: 'KeepAlive' });
      return;
    }
    // Commands run strictly in order.
    this.work = this.work.then(async () => {
      try {
        await this.dispatch(type, data);
      } catch {
        // A bad command must not take the socket down.
      }
    });
  }

  private async dispatch(type: string | null, data: unknown): Promise<void> {
    const map = isObject(data) ? data : {};
    switch (type) {
      case 'Play':
        return this.play(map);
      case 'Playstate':
        return this.playstate(map);
      case 'GeneralCommand':
        return this.general(map);
    }
  }

  private async play(d: Record<string, unknown>): Promise<void> {
    const ids = Array.isArray(d.ItemIds)
      ? d.ItemIds.filter((i): i is string => typeof i === 'string')
      : [];
    if (ids.length === 0) return;
    const command = typeof d.PlayCommand === 'string' ? d.PlayCommand : 'PlayNow';
    const startIndex = Math.min(Math.max(Math.trunc(asNumber(d.StartIndex) ?? 0), 0), ids.length - 1);
    const { client, player } = this.deps;
    const items = await client.itemsByIds(ids);
    const tracks: BaseItem[] = [];
    let start = 0;
    for (const item of items) {
      if (ids[startIndex] === item.id) start = tracks.length;
      tracks.push(...(await client.tracksOf(item)));
    }
    if (tracks.length === 0) return;
    switch (command) {
      case 'PlayNext':
        await player.playNext(tracks);
        break;
      case 'PlayLast':
        await player.addToQueue(tracks);
        break;
      case 'PlayShuffle':
        await player.playQueue(tracks, { shuffle: true });
        break;
      case 'PlayInstantMix': {
        const seed = items[0];
        if (seed) await player.playInstantMix(seed);
        break;
      }
      default: {
        await player.playQueue(tracks, { startIndex: start });
        const ticks = asNumber(d.StartPositionTicks) ?? 0;
        if (ticks > 0) await player.seek(ticksToMs(ticks));
      }
    }
  }

  private async playstate(d: Record<string, unknown>): Promise<void> {
    const { player } = this.deps;
    switch (d.Command) {
      case 'Stop':
        await player.stop();
        break;
      case 'Pause':
        await player.pause();
        break;
      case 'Unpause':
        await player.play();
        break;
      case 'PlayPause':
        await player.togglePlay();
        break;
      case 'NextTrack':
        await player.next();
        break;
      case 'PreviousTrack':
        await player.previous();
        break;
      case 'Seek': {
        const ticks = asNumber(d.SeekPositionTicks);
        if (ticks !== null) await player.seek(ticksToMs(ticks));
        break;
      }
      default:
        return;
    }
    player.reportNow();
  }

  private async general(d: Record<string, unknown>): Promise<void> {
    const { player, volume, setVolume, shuffled } = this.deps;
    const args = isObject(d.Arguments) ? d.Arguments : {};
    switch (d.Name) {
      case 'SetVolume': {
        const v = asNumber(args.Volume);
        if (v === null) return;
        await setVolume(clamp01(v / 100));
        break;
      }
      case 'VolumeUp':
        await setVolume(clamp01(volume() + 0.05));
        break;
      case 'VolumeDown':
        await setVolume(clamp01(volume() - 0.05));
        break;
      case 'Mute':
        await this.mute();
        break;
      case 'Unmute':
        await this.unmute();
        break;
      case 'ToggleMute':
        if (volume() <= 0) await this.unmute();
        else await this.mute();
        break;
      case 'SetRepeatMode': {
        const mode: RepeatMode =
          args.RepeatMode === 'RepeatAll' ? 'all' : args.RepeatMode === 'RepeatOne' ? 'one' : 'off';
        await player.setRepeat(mode);
        break;
      }
      case 'SetShuffleQueue': {
        const want = args.ShuffleMode === 'Shuffle';
        if (want !== shuffled()) await player.toggleShuffle();
        break;
      }
      default:
        return;
    }
    player.reportNow();
  }

  private async mute(): Promise<void> {
    const v = this.deps.volume();
    if (v > 0) this.volumeBeforeMute = v;
    await this.deps.setVolume(0);
  }

  private unmute(): Promise<void> {
    return this.deps.setVolume(this.volumeBeforeMute <= 0 ? 1 : this.volumeBeforeMute);
  }
}

/**
 * Keeps one JellyfinRemote alive for the signed-in profile. `sync(client)` is
 * called whenever the active client changes (null = signed out).
 */
export class RemoteController {
  private remote: JellyfinRemote | null = null;
  private syncing: Promise<void> = Promise.resolve();

  constructor(private readonly make: (client: JellyfinClient) => JellyfinRemote) {}

  get current(): JellyfinRemote | null {
    return this.remote;
  }

  get running(): boolean {
    return this.remote?.running ?? false;
  }

  /** Stops the old target and, when `client` is non-null, starts a new one. */
  sync(client: JellyfinClient | null): Promise<void> {
    this.syncing = this.syncing.then(async () => {
      await this.remote?.stop();
      this.remote = null;
      if (client) {
        const remote = this.make(client);
        this.remote = remote;
        await remote.start();
      }
    });
    return this.syncing;
  }

  stop(): Promise<void> {
    return this.sync(null);
  }
}
