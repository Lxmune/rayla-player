import type { MediaAction, NowPlayingInfo } from '../android';
import { artistLine } from '../jellyfin/models';
import type { BaseItem } from '../jellyfin/models';
import type { PlaybackState } from '../ipc';
import type { RepeatMode } from '../player/controller.svelte';

/** The slice of `PlayerController` the media session reads and drives. */
export interface MediaSessionPlayer {
  readonly current: BaseItem | null;
  readonly playback: PlaybackState;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly index: number;
  readonly repeat: RepeatMode;
  readonly queue: readonly unknown[];
  onEngineEvent(listener: () => void): () => void;
  play(): Promise<void>;
  pause(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  seek(positionMs: number): Promise<void>;
}

/** Matches the functions exported by `src/lib/android.ts`. */
export interface MediaBridge {
  updateNowPlaying(info: NowPlayingInfo): Promise<void>;
  clearNowPlaying(): Promise<void>;
  onMediaAction(cb: (a: MediaAction) => void): Promise<() => void>;
}

export interface MediaSessionDeps {
  player: MediaSessionPlayer;
  /** Cover URL (~512 px) for a track, or null. */
  artUrl: (item: BaseItem) => string | null;
  bridge: MediaBridge;
  /** Called when a player action from the OS fails. */
  onError?: (e: unknown) => void;
  /** Whether a track is a favourite (notification heart filled). */
  isLiked?: (item: BaseItem) => boolean;
  /** Notification "like" action (toggle favourite); ignored when absent. */
  onLike?: () => void;
  /** Notification "not for me" action; ignored when absent. */
  onDislike?: () => void;
  clock?: () => number;
}

/**
 * Keeps Android's media session (notification, lock screen, headset buttons)
 * in sync with the player. Android extrapolates the position while playing, so
 * updates go out only on track / play-state / duration / seek changes and as a
 * re-sync every `resyncMs` while playing. Nothing is shown until playback has
 * started once in this app session.
 */
export class MediaSession {
  static readonly resyncMs = 15_000;
  static readonly seekThresholdMs = 2000;
  static readonly debounceMs = 50;

  private readonly clock: () => number;
  private started = false;
  private shown = false;
  private disposed = false;
  private key: string | null = null;
  private lastPos = 0;
  private lastTick = 0;
  private lastPush = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unEvents: (() => void) | null = null;
  private unActions: (() => void) | null = null;

  constructor(private readonly d: MediaSessionDeps) {
    this.clock = d.clock ?? Date.now;
  }

  /** Subscribes to player events and media actions. */
  async start(): Promise<void> {
    this.unEvents = this.d.player.onEngineEvent(() => this.observe());
    try {
      const un = await this.d.bridge.onMediaAction((a) => this.handle(a));
      if (this.disposed) un();
      else this.unActions = un;
    } catch (e) {
      this.d.onError?.(e);
    }
  }

  /** Re-reads the player; call after changes that emit no engine event. */
  observe(): void {
    if (this.disposed) return;
    const p = this.d.player;
    const now = this.clock();
    const playing = p.playback === 'playing' || p.playback === 'buffering';
    if (playing) this.started = true;
    const expected = this.lastPos + (this.lastPlaying ? now - this.lastTick : 0);
    const jumped = this.key !== null && Math.abs(p.positionMs - expected) > MediaSession.seekThresholdMs;
    this.lastPos = p.positionMs;
    this.lastTick = now;
    this.lastPlaying = playing;

    const key = JSON.stringify([
      p.current?.id ?? null,
      p.index,
      playing,
      Math.floor(p.durationMs / 1000),
      this.canPrevious(),
      this.canNext(),
      this.liked(p.current),
    ]);
    const changed = key !== this.key;
    this.key = key;
    const resync = playing && this.shown && now - this.lastPush >= MediaSession.resyncMs;
    if (changed || jumped || resync) this.schedule();
  }

  /** Stops listening; the bridge is never called afterwards. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.unEvents?.();
    this.unActions?.();
    this.unEvents = this.unActions = null;
  }

  private lastPlaying = false;

  private liked(item: BaseItem | null): boolean {
    if (item === null) return false;
    try {
      return this.d.isLiked?.(item) ?? false;
    } catch {
      return false;
    }
  }

  private canNext(): boolean {
    const p = this.d.player;
    return p.current !== null && (p.index + 1 < p.queue.length || p.repeat === 'all');
  }

  private canPrevious(): boolean {
    const p = this.d.player;
    return p.current !== null && (p.index > 0 || (p.repeat === 'all' && p.queue.length > 1));
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, MediaSession.debounceMs);
  }

  private flush(): void {
    if (this.disposed || !this.started) return;
    const p = this.d.player;
    const item = p.current;
    if (item === null || p.playback === 'stopped') {
      if (this.shown) {
        this.shown = false;
        void this.d.bridge.clearNowPlaying().catch(() => {});
      }
      return;
    }
    this.shown = true;
    this.lastPush = this.clock();
    void this.d.bridge
      .updateNowPlaying({
        title: item.name,
        artist: artistLine(item),
        album: item.album ?? '',
        artUrl: this.d.artUrl(item),
        durationMs: p.durationMs,
        positionMs: Math.max(0, Math.round(p.positionMs)),
        playing: p.playback === 'playing' || p.playback === 'buffering',
        canPrevious: this.canPrevious(),
        canNext: this.canNext(),
        liked: this.liked(item),
      })
      .catch(() => {});
  }

  private handle(a: MediaAction): void {
    if (this.disposed) return;
    const p = this.d.player;
    let call: Promise<void>;
    try {
      call = this.run(a, p);
    } catch (e) {
      this.d.onError?.(e);
      return;
    }
    call.catch((e) => this.d.onError?.(e));
  }

  private run(a: MediaAction, p: MediaSessionPlayer): Promise<void> {
    let call: Promise<void>;
    switch (a.type) {
      case 'play':
        call = p.play();
        break;
      case 'pause':
      case 'stop':
      case 'noisy':
        call = p.pause();
        break;
      case 'next':
        call = p.next();
        break;
      case 'previous':
        call = p.previous();
        break;
      case 'seek':
        call = p.seek(a.positionMs);
        break;
      case 'like':
        this.d.onLike?.();
        return Promise.resolve();
      case 'dislike':
        this.d.onDislike?.();
        return Promise.resolve();
      default:
        return Promise.resolve();
    }
    return call;
  }
}
