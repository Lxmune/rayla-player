// Sleep timer: pauses playback after a delay, at the end of the current track or of the current album.

import type { PlayerController, PlayerEvent } from './controller.svelte';

export type SleepMode = 'off' | 'timer' | 'track' | 'album';

/** A minute timer ramps the volume down over its last minute. */
export const FADE_MS = 60_000;

export interface SleepTimerDeps {
  player: Pick<PlayerController, 'pause' | 'onEngineEvent' | 'currentEntry' | 'queue'>;
  /** Epoch ms. Default Date.now. */
  now?: () => number;
  /** Applies a transient volume factor 0..1 (1 restores). Not persisted by the caller. */
  setVolumeScale?: (scale: number) => void;
  /** Whether the fade-out is wanted (setting). Default off. */
  fadeEnabled?: () => boolean;
}

const TICK_MS = 1000;

export class SleepTimer {
  mode = $state<SleepMode>('off');
  /** Time left of a minute timer; 0 otherwise. */
  remainingMs = $state(0);

  private readonly player: SleepTimerDeps['player'];
  private readonly now: () => number;
  private readonly setScale: (scale: number) => void;
  private readonly fadeEnabled: () => boolean;
  private endsAt = 0;
  private trackUid: number | null = null;
  private albumId: string | null = null;
  private fading = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private unlisten: (() => void) | null = null;

  constructor(deps: SleepTimerDeps) {
    this.player = deps.player;
    this.now = deps.now ?? Date.now;
    this.setScale = deps.setVolumeScale ?? (() => {});
    this.fadeEnabled = deps.fadeEnabled ?? (() => false);
  }

  start(minutes: number): void {
    this.cancel();
    if (!(minutes > 0)) return;
    this.mode = 'timer';
    this.endsAt = this.now() + minutes * 60_000;
    this.remainingMs = minutes * 60_000;
    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  /** Pause once the current track is over. */
  endOfTrack(): void {
    this.cancel();
    const entry = this.player.currentEntry;
    if (!entry) return;
    this.mode = 'track';
    this.trackUid = entry.uid;
    this.unlisten = this.player.onEngineEvent((e) => this.onEvent(e));
  }

  /** Pause once the current album is over (the next track belongs to another album, or there is none). */
  endOfAlbum(): void {
    this.cancel();
    const entry = this.player.currentEntry;
    if (!entry) return;
    this.albumId = entry.item.albumId ?? null;
    // Without an album this degrades to "end of track".
    this.mode = this.albumId === null ? 'track' : 'album';
    this.trackUid = entry.uid;
    this.unlisten = this.player.onEngineEvent((e) => this.onEvent(e));
  }

  cancel(): void {
    this.restoreVolume();
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
    this.unlisten?.();
    this.unlisten = null;
    this.trackUid = null;
    this.albumId = null;
    this.mode = 'off';
    this.remainingMs = 0;
  }

  private tick(): void {
    this.remainingMs = Math.max(0, this.endsAt - this.now());
    if (this.remainingMs <= 0) {
      this.fire();
    } else if (this.remainingMs < FADE_MS && this.fadeEnabled()) {
      this.fading = true;
      this.setScale(this.remainingMs / FADE_MS);
    }
  }

  private restoreVolume(): void {
    if (!this.fading) return;
    this.fading = false;
    this.setScale(1);
  }

  private onEvent(e: PlayerEvent): void {
    if (this.mode === 'album') {
      this.onAlbumEvent(e);
      return;
    }
    const uid = this.trackUid;
    if (uid === null) return;
    const ended = e.kind === 'trackEnded' && e.entry?.uid === uid;
    const moved = e.kind === 'trackStarted' && e.entry !== null && e.entry.uid !== uid;
    if (ended || moved) this.fire();
  }

  private onAlbumEvent(e: PlayerEvent): void {
    const album = this.albumId;
    if (album === null) return;
    const entry = e.entry;
    // The next album's first track started (gapless), or the queue ran out.
    const moved = e.kind === 'trackStarted' && entry !== null && (entry.item.albumId ?? null) !== album;
    const ended =
      e.kind === 'trackEnded' && entry?.uid === this.trackUid && (entry.item.albumId ?? null) === album && this.queueEnds(entry.uid);
    if (moved || ended) this.fire();
    else if (e.kind === 'trackStarted' && entry) this.trackUid = entry.uid;
  }

  private queueEnds(uid: number): boolean {
    const q = this.player.queue;
    const i = q.findIndex((x) => x.uid === uid);
    const next = i >= 0 ? q[i + 1] : undefined;
    return next === undefined || (next.item.albumId ?? null) !== this.albumId;
  }

  private fire(): void {
    const fading = this.fading;
    this.fading = false; // restore only after the pause, so the volume never jumps back up while playing
    this.cancel();
    void this.player.pause().then(() => {
      if (fading) this.setScale(1);
    });
  }
}
