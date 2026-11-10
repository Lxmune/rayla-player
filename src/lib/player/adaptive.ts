// Adaptive streaming quality: pick the bitrate cap for upcoming tracks from the
// measured download rate.

/** Weight of a new sample in the throughput average. */
export const THROUGHPUT_ALPHA = 0.3;

/** Exponentially weighted average; zero or invalid samples are ignored. */
export function ewma(prev: number | null, sample: number, alpha = THROUGHPUT_ALPHA): number | null {
  if (!Number.isFinite(sample) || sample <= 0) return prev;
  return prev === null ? sample : prev + alpha * (sample - prev);
}

/** [minimum rate in bits/s, highest cap allowed at that rate in bits/s]. Fastest first. */
const LADDER: readonly (readonly [number, number])[] = [
  [1_200_000, 320_000],
  [600_000, 192_000],
  [300_000, 128_000],
];
const FULL_RATE = 3_000_000;
const FLOOR_CAP = 96_000;

/**
 * The cap to use: the user's own cap when adaptive is off or nothing was measured
 * yet; otherwise the lower of it and what the connection sustains. `null` = original.
 */
export function effectiveMaxBitrate(
  userCap: number | null,
  adaptive: boolean,
  throughputBps: number | null,
): number | null {
  if (!adaptive || throughputBps === null || throughputBps <= 0) return userCap;
  if (throughputBps >= FULL_RATE) return userCap;
  let limit = FLOOR_CAP;
  for (const [rate, cap] of LADDER) {
    if (throughputBps >= rate) {
      limit = cap;
      break;
    }
  }
  return userCap === null ? limit : Math.min(userCap, limit);
}
