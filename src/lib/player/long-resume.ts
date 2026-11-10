// Remembered positions of long tracks (audiobooks, DJ mixes), per profile, in kv.

import type { KeyValueStore } from '../platform';
import type { LongResumeStore } from './controller.svelte';

export const longResumeKey = (profileId: string): string => `player.longResume.${profileId}`;

const MAX_ENTRIES = 200;

/** Parses `{ itemId: positionMs }`; anything malformed yields an empty map. */
export function parseLongResume(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const j: unknown = JSON.parse(raw);
    if (typeof j !== 'object' || j === null || Array.isArray(j)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
}

/** kv-backed store for the active profile (`profileId()` null = nothing is remembered). */
export function kvLongResume(kv: KeyValueStore, profileId: () => string | null): LongResumeStore {
  const read = (id: string): Record<string, number> => {
    try {
      return parseLongResume(kv.get(longResumeKey(id)));
    } catch {
      return {};
    }
  };
  return {
    get(itemId) {
      const id = profileId();
      return id ? (read(id)[itemId] ?? null) : null;
    },
    set(itemId, positionMs) {
      const id = profileId();
      if (!id) return;
      const map = read(id);
      // Re-insert so the most recently saved entry is last; the oldest are dropped first.
      delete map[itemId];
      if (positionMs !== null && positionMs > 0) map[itemId] = positionMs;
      const keys = Object.keys(map);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete map[k];
      try {
        kv.set(longResumeKey(id), JSON.stringify(map));
      } catch {
        // storage full / unavailable: resume is a convenience
      }
    },
  };
}
