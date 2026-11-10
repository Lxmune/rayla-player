// Sleep timer: pauses playback after a delay, or when the current track ends.

import type { PlayerController, PlayerEvent } from './controller.svelte';

export type SleepMode = 'off' | 'timer' | 'track';

export interface SleepTimerDeps {
  player: Pick<PlayerController, 'pause' | 'onEngineEvent' | 'currentEntry'>;
  /** Epoch ms. Default Date.now. */
  now?: () => number;
}

const TICK_MS = 1000;

export class SleepTimer {
  mode = $state<SleepMode>('off');
  /** Time left of a minute timer; 0 otherwise. */
  remainingMs = $state(0);

  private readonly player: SleepTimerDeps['player'];
  private readonly now: () => number;
  private endsAt = 0;
  private trackUid: number | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private unlisten: (() => void) | null = null;

  constructor(deps: SleepTimerDeps) {
    this.player = deps.player;
    this.now = deps.now ?? Date.now;
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

  cancel(): void {
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
    this.unlisten?.();
    this.unlisten = null;
    this.trackUid = null;
    this.mode = 'off';
    this.remainingMs = 0;
  }

  private tick(): void {
    this.remainingMs = Math.max(0, this.endsAt - this.now());
    if (this.remainingMs <= 0) this.fire();
  }

  private onEvent(e: PlayerEvent): void {
    const uid = this.trackUid;
    if (uid === null) return;
    const ended = e.kind === 'trackEnded' && e.entry?.uid === uid;
    const moved = e.kind === 'trackStarted' && e.entry !== null && e.entry.uid !== uid;
    if (ended || moved) this.fire();
  }

  private fire(): void {
    this.cancel();
    void this.player.pause();
  }
}
