// Pure (de)serialisation of the "resume playback" snapshot. Parsing is
// defensive: anything malformed yields null, never a throw.

import { baseItemToJson, parseBaseItem, type BaseItem } from '../jellyfin/models';
import type { RepeatMode } from './controller.svelte';

export interface ResumeSnapshot {
  /** Queue in play order. */
  items: BaseItem[];
  index: number;
  positionMs: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

/** Key/value key, per profile so accounts do not share a queue. */
export const resumeKey = (profileId: string): string => `player.resume.${profileId}`;

export function serializeResume(s: ResumeSnapshot): string {
  return JSON.stringify({
    v: 1,
    items: s.items.map(baseItemToJson),
    index: s.index,
    positionMs: s.positionMs,
    shuffle: s.shuffle,
    repeat: s.repeat,
  });
}

export function parseResume(raw: string | null): ResumeSnapshot | null {
  if (!raw) return null;
  try {
    const j: unknown = JSON.parse(raw);
    if (typeof j !== 'object' || j === null) return null;
    const o = j as Record<string, unknown>;
    if (!Array.isArray(o.items) || o.items.length === 0) return null;
    const items = o.items.map((i) => parseBaseItem(i));
    const index = Number(o.index);
    if (!Number.isInteger(index) || index < 0 || index >= items.length) return null;
    const positionMs = Number(o.positionMs);
    const repeat = o.repeat === 'all' || o.repeat === 'one' ? o.repeat : 'off';
    return {
      items,
      index,
      positionMs: Number.isFinite(positionMs) && positionMs > 0 ? Math.floor(positionMs) : 0,
      shuffle: o.shuffle === true,
      repeat,
    };
  } catch {
    return null;
  }
}
