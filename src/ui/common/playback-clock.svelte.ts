// Smooth playback position. The engine reports ~5 Hz; between reports the clock
// extrapolates with requestAnimationFrame while playing. It never runs backwards
// on small engine jitter, only on a real seek (jump > BACK_TOLERANCE_MS).

const BACK_TOLERANCE_MS = 750;

/** Pure interpolation core (no DOM), unit tested. */
export class ClockCore {
  private anchorMs = 0;
  private anchorAt = 0;
  private playing = false;
  private shown = 0;

  /** Feed the latest known engine position. */
  sync(positionMs: number, playing: boolean, now: number): void {
    const est = this.estimate(now);
    this.anchorMs = positionMs;
    this.anchorAt = now;
    this.playing = playing;
    // hold the estimate through small backwards jitter while playing
    this.shown = playing && positionMs < est && est - positionMs < BACK_TOLERANCE_MS ? est : positionMs;
  }

  private estimate(now: number): number {
    return this.playing ? this.anchorMs + Math.max(0, now - this.anchorAt) : this.anchorMs;
  }

  read(now: number, durationMs: number): number {
    const est = this.playing ? Math.max(this.estimate(now), this.shown) : this.anchorMs;
    return Math.max(0, durationMs > 0 ? Math.min(est, durationMs) : est);
  }
}

interface ClockSource {
  readonly positionMs: number;
  readonly durationMs: number;
  readonly isPlaying: boolean;
}

export interface PlaybackClock {
  /** Interpolated position in ms (updates every frame while playing). */
  readonly ms: number;
  /** Whole seconds; reactive consumers only re-render when it changes. */
  readonly seconds: number;
}

/** Call during component init (uses $effect). */
export function createPlaybackClock(source: ClockSource): PlaybackClock {
  const core = new ClockCore();
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let ms = $state(source.positionMs);
  const seconds = $derived(Math.floor(ms / 1000));
  let hidden = $state(typeof document !== 'undefined' && document.hidden);

  $effect(() => {
    const pos = source.positionMs;
    const playing = source.isPlaying;
    const dur = source.durationMs;
    core.sync(pos, playing, clock());
    ms = core.read(clock(), dur);
    if (!playing || hidden || typeof requestAnimationFrame !== 'function') return;
    let raf = 0;
    const tick = () => {
      ms = core.read(clock(), source.durationMs);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  $effect(() => {
    if (typeof document === 'undefined') return;
    const onvis = () => (hidden = document.hidden);
    document.addEventListener('visibilitychange', onvis);
    return () => document.removeEventListener('visibilitychange', onvis);
  });

  return {
    get ms() {
      return ms;
    },
    get seconds() {
      return seconds;
    },
  };
}
