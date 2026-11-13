import type { DiscordActivity, PlaybackState, SignalPath } from '../ipc';
import type { DiscordSettings, DiscordStatusDisplay } from '../settings/types';
import type { TrackMeta } from '../track-meta';
import { coverUrl, discordVars, hasRealApplicationId, renderPresence } from './discord-template';

/** Discord's `status_display_type` values. */
const STATUS_DISPLAY_TYPE: Record<DiscordStatusDisplay, 0 | 1 | 2> = { name: 0, state: 1, details: 2 };

/** Matches `ipc.discordSetActivity`. */
export type SetActivity = (applicationId: string, activity: DiscordActivity | null) => Promise<void>;

export interface PresenceObservation {
  /** null = nothing loaded. */
  meta: TrackMeta | null;
  /** Queue-entry id (distinguishes repeats of the same track); may be null. */
  entryId: string | null;
  state: PlaybackState;
  positionMs: number;
  durationMs: number;
  signalPath: SignalPath | null;
}

/** Decides when to push Rich Presence. Updates go out on track change, play/pause,
 *  signal path change, settings change and seeks, never on every position tick. */
export class DiscordPresence {
  /** Position jump (beyond normal playback) that counts as a seek. */
  static readonly seekThresholdMs = 3000;

  private key: string | null = null;
  private activeAppId: string | null = null;
  private lastPositionMs = 0;
  private lastTick = 0;

  constructor(
    private readonly setActivity: SetActivity,
    private readonly clock: () => number = Date.now,
  ) {}

  async observe(settings: DiscordSettings, o: PresenceObservation): Promise<void> {
    const now = this.clock();
    const playing = o.state === 'playing';
    const expected = playing ? this.lastPositionMs + (now - this.lastTick) : this.lastPositionMs;
    const jumped = Math.abs(o.positionMs - expected) > DiscordPresence.seekThresholdMs;
    this.lastPositionMs = o.positionMs;
    this.lastTick = now;

    const key = JSON.stringify([
      settings,
      o.meta?.id ?? null,
      o.entryId,
      o.state,
      o.signalPath,
      Math.floor(o.durationMs / 1000),
    ]);
    const changed = key !== this.key;
    this.key = key;
    if (!changed && !(jumped && playing && o.meta !== null)) return;
    await this.push(settings, o, now);
  }

  /** Clears any shown presence (e.g. on app shutdown). */
  async clear(): Promise<void> {
    this.key = null;
    await this.clearActive();
  }

  private async clearActive() {
    if (this.activeAppId === null) return;
    const id = this.activeAppId;
    this.activeAppId = null;
    await this.setActivity(id, null).catch(() => {});
  }

  private async push(s: DiscordSettings, o: PresenceObservation, now: number) {
    const appId = s.applicationId.trim();
    // Switching application ids: clear the old one first.
    if (this.activeAppId !== null && this.activeAppId !== appId) await this.clearActive();
    const meta = o.meta;
    const paused = o.state === 'paused';
    const active =
      s.enabled &&
      hasRealApplicationId(s) &&
      meta !== null &&
      o.state !== 'stopped' &&
      (o.state === 'playing' || o.state === 'buffering' || (paused && s.showWhenPaused));
    if (!active || meta === null) {
      await this.clearActive();
      return;
    }
    const r = renderPresence(
      s,
      discordVars({
        meta,
        signal: o.signalPath,
        positionMs: o.positionMs,
        durationMs: o.durationMs,
        publicUrl: s.publicUrl,
      }),
    );
    const cover = s.showCover ? coverUrl(meta, s.publicUrl) : null;
    // Discord runs the clock itself, so a paused track shows no time at all.
    const start = s.time !== 'off' && !paused ? now - o.positionMs : null;
    const end = start !== null && s.time === 'bar' && o.durationMs > 0 ? start + o.durationMs : null;
    this.activeAppId = appId;
    await this.setActivity(appId, {
      details: r.details,
      state: r.state,
      largeImage: cover ?? 'rayla',
      largeText: r.largeText || null,
      smallImage: paused ? 'pause' : 'play',
      smallText: r.smallText || null,
      startTimestampMs: start,
      endTimestampMs: end,
      buttons: r.buttons,
      statusDisplayType: STATUS_DISPLAY_TYPE[s.statusDisplay],
    }).catch(() => {});
  }
}
